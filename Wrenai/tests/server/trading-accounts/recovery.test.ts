import { createSecretKey, generateKeyPairSync, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { executionTestContext } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tradingAccounts } from "@/server/db/trading-account-schema";
import { hashNep413Payload } from "@/server/near/nep413";
import {
  confirmTradingBackup,
  exportTradingRecovery,
  issueRecoveryChallenge,
} from "@/server/trading-accounts/recovery";
import {
  activeTradingAccount,
  revokeTradingAccounts,
  tradingAccountSigningKeys,
} from "@/server/trading-accounts/vault";
import { openRecoveryFile, recoveryFileHash, sealRecoveryFile } from "@/shared/recovery-file";
import { recoveryEnvelopeSchema, recoveryPayloadSchema } from "@/shared/trading-recovery";
import { recoverTradingKeys } from "../../../scripts/recover-trading-account";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({
    appOrigin: "https://wrenai.example",
    appHost: "wrenai.example",
    keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)),
  }),
}));
const access = vi.hoisted(() => vi.fn());
vi.mock("@/server/near/rpc", () => ({ hasFullAccessKey: access }));
const user = { id: "owner", accountId: "owner.near" };
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  access.mockReset().mockResolvedValue(true);
});
afterEach(async () => context.postgres.close());

async function proof(): Promise<{
  readonly agentId: string;
  readonly nonce: string;
  readonly signature: string;
  readonly publicKey: string;
}> {
  const challenge = await issueRecoveryChallenge(context.db, user, { agentId: context.agentId });
  const wallet = generateKeyPairSync("ed25519");
  return {
    agentId: context.agentId,
    nonce: challenge.nonce,
    publicKey: `ed25519:${base58.encode(wallet.publicKey.export({ format: "der", type: "spki" }).subarray(-32))}`,
    signature: sign(
      null,
      hashNep413Payload({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: Buffer.from(challenge.nonce, "base64url"),
      }),
      wallet.privateKey,
    ).toString("base64"),
  };
}
describe("unfunded shared trading accounts and independent recovery", () => {
  it("requires a saved owned agent and a fresh one-use full-access proof before exporting keys", async () => {
    await expect(
      issueRecoveryChallenge(context.db, user, { agentId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
    const input = await proof();
    await expect(
      exportTradingRecovery(context.db, { id: "stranger", accountId: "stranger.near" }, input),
    ).rejects.toMatchObject({ code: "not_found" });
    access.mockResolvedValue(false);
    await expect(exportTradingRecovery(context.db, user, input)).rejects.toMatchObject({ code: "not_ready" });
    expect(await activeTradingAccount(context.db, user.id)).toBeNull();
    access.mockResolvedValue(true);
    const exported = await exportTradingRecovery(context.db, user, input);
    expect(exported.payload.ownerAccountId).toBe("owner.near");
    await expect(exportTradingRecovery(context.db, user, input)).rejects.toMatchObject({ code: "not_ready" });
    const stored = await activeTradingAccount(context.db, user.id);
    expect(stored?.sealedKeys).not.toContain(exported.payload.native.privateKey);
    expect(stored?.sealedKeys).not.toContain(exported.payload.perps.privateKey);
    expect(stored?.backupConfirmedAt).toBeNull();
  });
  it("blocks signing until backup acknowledgement and erases stored keys when authorization is revoked", async () => {
    const exported = await exportTradingRecovery(context.db, user, await proof());
    const id = exported.payload.accountId;
    await expect(tradingAccountSigningKeys(context.db, user.id, id)).rejects.toMatchObject({
      code: "not_ready",
    });
    const file = await sealRecoveryFile(exported.payload, "offline fixture password 2026");
    const confirmation = {
      accountId: id,
      token: exported.confirmationToken,
      fileHash: await recoveryFileHash(file),
    };
    await expect(confirmTradingBackup(context.db, "stranger", confirmation)).rejects.toMatchObject({
      code: "not_found",
    });
    await confirmTradingBackup(context.db, user.id, confirmation);
    await confirmTradingBackup(context.db, user.id, confirmation);
    await expect(
      confirmTradingBackup(context.db, user.id, { ...confirmation, token: "a".repeat(43) }),
    ).rejects.toMatchObject({ code: "not_ready" });
    const keys = await tradingAccountSigningKeys(context.db, user.id, id);
    expect(keys.native.getPublicKey().toString()).toBe(exported.payload.native.publicKey);
    expect(keys.perps.address).toBe(exported.payload.perps.address);
    await revokeTradingAccounts(context.db, user.id);
    const [stored] = await context.db.select().from(tradingAccounts).where(eq(tradingAccounts.id, id));
    expect(stored?.sealedKeys).toBeNull();
    expect(stored?.revokedAt).not.toBeNull();
    await expect(tradingAccountSigningKeys(context.db, user.id, id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await openRecoveryFile(file, "offline fixture password 2026")).toEqual(exported.payload);
  });
  it("opens app-generated backups through the offline command and independently derives agent keys", async () => {
    const exported = await exportTradingRecovery(context.db, user, await proof());
    const password = "offline recovery fixture passphrase";
    const file = await sealRecoveryFile(exported.payload, password);
    await revokeTradingAccounts(context.db, user.id);
    const recovered = await recoverTradingKeys(file, password, 0);
    expect(recovered.recovery).toEqual(exported.payload);
    expect(recovered.agent?.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(recovered.agent?.address).not.toBe(recovered.recovery.perps.address);
    await expect(recoverTradingKeys(file, "incorrect offline password")).rejects.toThrow();
    await expect(recoverTradingKeys(file, password, 1000)).rejects.toThrow();
    const envelope = recoveryEnvelopeSchema.parse(JSON.parse(file));
    await expect(
      openRecoveryFile(JSON.stringify({ ...envelope, iterations: 1 }), password),
    ).rejects.toThrow();
    await expect(
      openRecoveryFile(
        JSON.stringify({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }),
        password,
      ),
    ).rejects.toThrow();
  });
  it("preserves old backups and rejects an encrypted payload with mismatched key identity", async () => {
    const exported = await exportTradingRecovery(context.db, user, await proof());
    const payload = exported.payload,
      password = "legacy recovery fixture passphrase";
    const legacy = recoveryPayloadSchema.parse({
      ...payload,
      format: "wrenai-trading-recovery-v1",
      perps: {
        venue: payload.perps.venue,
        address: payload.perps.address,
        privateKey: payload.perps.privateKey,
      },
    });
    const file = await sealRecoveryFile(legacy, password);
    expect((await recoverTradingKeys(file, password)).recovery).toEqual(legacy);
    await expect(recoverTradingKeys(file, password, 0)).rejects.toThrow("older backup");
    const mismatch = await sealRecoveryFile(
      { ...legacy, native: { ...legacy.native, accountId: "a".repeat(64) } },
      password,
    );
    await expect(recoverTradingKeys(mismatch, password)).rejects.toThrow("account identities");
  });
  it("enforces account identity, secret erasure and retained recovery history in SQL", async () => {
    const exported = await exportTradingRecovery(context.db, user, await proof());
    const id = exported.payload.accountId;
    await expect(
      context.db
        .update(tradingAccounts)
        .set({ nativeAccountId: "a".repeat(64) })
        .where(eq(tradingAccounts.id, id)),
    ).rejects.toThrow();
    await expect(
      context.db.update(tradingAccounts).set({ sealedKeys: "replacement" }).where(eq(tradingAccounts.id, id)),
    ).rejects.toThrow();
    await expect(context.db.delete(tradingAccounts).where(eq(tradingAccounts.id, id))).rejects.toThrow();
    await revokeTradingAccounts(context.db, user.id);
    await expect(
      context.db
        .update(tradingAccounts)
        .set({ revokedAt: null, sealedKeys: "replacement" })
        .where(eq(tradingAccounts.id, id)),
    ).rejects.toThrow();
    expect((await context.db.select().from(tradingAccounts))[0]).toMatchObject({ id, sealedKeys: null });
  });
});
