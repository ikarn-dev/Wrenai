import { createSecretKey, generateKeyPairSync, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { testDatabase } from "@tests/server/db/test-database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intentsSessions } from "@/server/db/preview-schema";
import {
  completeBalanceSession,
  issueBalanceChallenge,
  privateBalanceToken,
} from "@/server/execution/balance-session";
import { oneClickJson } from "@/server/execution/oneclick-quote";
import { hashNep413Payload } from "@/server/near/nep413";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/near/rpc", () => ({
  hasFullAccessKey: async () => true,
  callViewFunction: async () => ({ value: "252812b3", blockHeight: 1 }),
}));
vi.mock("@/server/execution/oneclick-quote", () => ({ oneClickJson: vi.fn() }));
const user = { id: "owner", accountId: "owner.near" };
let context: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  context = await testDatabase();
  vi.mocked(oneClickJson).mockReset().mockResolvedValue({
    accessToken: "private-read-access-fixture",
    refreshToken: "private-read-refresh-fixture",
    expiresIn: 3600,
    refreshExpiresIn: 86400,
  });
});
afterEach(async () => context.postgres.close());

describe("private balance connection", () => {
  it("binds a one-use read-only wallet signature to the signed-in owner and encrypts provider tokens", async () => {
    const challenge = await issueBalanceChallenge(context.db, user);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = `ed25519:${base58.encode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32))}`;
    const signature = sign(
      null,
      hashNep413Payload({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: Buffer.from(challenge.nonce, "base64url"),
      }),
      keys.privateKey,
    ).toString("base64");
    const input = { accountId: user.accountId, publicKey, signature, nonce: challenge.nonce };
    expect(JSON.parse(challenge.message)).toMatchObject({ signer_id: user.accountId, intents: [] });
    await completeBalanceSession(context.db, user, input);
    expect(await privateBalanceToken(context.db, user.id)).toBe("private-read-access-fixture");
    expect(await privateBalanceToken(context.db, "stranger")).toBeNull();
    const [row] = await context.db.select().from(intentsSessions).where(eq(intentsSessions.userId, user.id));
    expect(row?.sealedTokens).not.toContain("private-read-access-fixture");
    await expect(completeBalanceSession(context.db, user, input)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(oneClickJson).toHaveBeenCalledTimes(1);
  });
  it("rejects another user's challenge and a changed signature before exchanging provider credentials", async () => {
    const challenge = await issueBalanceChallenge(context.db, user);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = `ed25519:${base58.encode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32))}`;
    const invalid = {
      accountId: "stranger.near",
      publicKey,
      signature: Buffer.alloc(64).toString("base64"),
      nonce: challenge.nonce,
    };
    await expect(
      completeBalanceSession(context.db, { id: "stranger", accountId: "stranger.near" }, invalid),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(
      completeBalanceSession(context.db, user, { ...invalid, accountId: user.accountId }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(oneClickJson).not.toHaveBeenCalled();
  });
});
