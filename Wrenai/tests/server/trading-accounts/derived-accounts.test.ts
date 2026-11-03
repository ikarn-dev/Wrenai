import { createSecretKey } from "node:crypto";
import { executionTestContext, ledgerStrategyFixture } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { HDNodeWallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import { agentTradingAccounts, tradingAccounts } from "@/server/db/trading-account-schema";
import { agentPerpsSigningWallet, ensureAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import {
  activeTradingAccount,
  ensureTradingAccount,
  revokeTradingAccounts,
  tradingRecoveryPayload,
} from "@/server/trading-accounts/vault";
import { derivePerpsWallet } from "@/shared/perps-derivation";
import { openRecoveryFile, sealRecoveryFile } from "@/shared/recovery-file";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  await context.db.update(agents).set({ pack: "perps" }).where(eq(agents.id, context.agentId));
});
afterEach(async () => context.postgres.close());
async function backedUpRoot(): Promise<Awaited<ReturnType<typeof ensureTradingAccount>>> {
  const root = await ensureTradingAccount(context.db, "owner");
  const [updated] = await context.db
    .update(tradingAccounts)
    .set({ backupConfirmedAt: Date.now(), backupFileHash: "a".repeat(64), backupVersion: 2 })
    .where(eq(tradingAccounts.id, root.id))
    .returning();
  if (!updated) {
    throw new Error("Missing recovery fixture.");
  }
  return updated;
}
describe("separate Perps addresses backed by one independently recoverable seed", () => {
  it("does not derive an address without an owned saved agent and a confirmed v2 backup", async () => {
    await expect(ensureAgentTradingAccount(context.db, "owner", crypto.randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(ensureAgentTradingAccount(context.db, "owner", context.agentId)).rejects.toMatchObject({
      code: "not_ready",
    });
    const root = await ensureTradingAccount(context.db, "owner");
    await context.db
      .update(tradingAccounts)
      .set({ backupConfirmedAt: Date.now(), backupFileHash: "b".repeat(64) })
      .where(eq(tradingAccounts.id, root.id));
    await expect(ensureAgentTradingAccount(context.db, "owner", context.agentId)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await context.db.select().from(agentTradingAccounts)).toHaveLength(0);
  });
  it("derives stable distinct addresses, binds ownership, and recovers them after server-key erasure", async () => {
    const root = await backedUpRoot(),
      first = await ensureAgentTradingAccount(context.db, "owner", context.agentId);
    const otherId = crypto.randomUUID();
    await context.db.insert(agents).values({
      id: otherId,
      userId: "owner",
      pack: "perps",
      name: "Other agent",
      status: "paused",
      reason: "Offline fixture",
      policyJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await context.db.insert(strategyVersions).values(ledgerStrategyFixture(otherId));
    const second = await ensureAgentTradingAccount(context.db, "owner", otherId);
    expect(second.derivationIndex).toBe(first.derivationIndex + 1);
    expect(second.perpAddress).not.toBe(first.perpAddress);
    expect((await ensureAgentTradingAccount(context.db, "owner", context.agentId)).perpAddress).toBe(
      first.perpAddress,
    );
    await expect(agentPerpsSigningWallet(context.db, "stranger", context.agentId)).rejects.toMatchObject({
      code: "not_ready",
    });
    const payload = tradingRecoveryPayload(root, "owner.near"),
      file = await sealRecoveryFile(payload, "offline derived address backup");
    await revokeTradingAccounts(context.db, "owner");
    expect(await activeTradingAccount(context.db, "owner")).toBeNull();
    await expect(agentPerpsSigningWallet(context.db, "owner", context.agentId)).rejects.toMatchObject({
      code: "not_ready",
    });
    const recovered = await openRecoveryFile(file, "offline derived address backup");
    if (recovered.format !== "wrenai-trading-recovery-v2") {
      throw new Error("Expected derived recovery format.");
    }
    expect(
      HDNodeWallet.fromSeed(recovered.perps.privateKey).derivePath(
        `${recovered.perps.derivation.pathPrefix}/${first.derivationIndex}`,
      ).address,
    ).toBe(first.perpAddress);
    expect(
      HDNodeWallet.fromSeed(recovered.perps.privateKey).derivePath(
        `${recovered.perps.derivation.pathPrefix}/${second.derivationIndex}`,
      ).address,
    ).toBe(second.perpAddress);
    expect(first.perpAddress).not.toBe(recovered.perps.address);
  });
  it("enforces immutable address/root/index, monotonic nonces and retained recovery history in SQL", async () => {
    const root = await backedUpRoot(),
      account = await ensureAgentTradingAccount(context.db, "owner", context.agentId);
    await context.db
      .update(agentTradingAccounts)
      .set({ lastNonce: 100 })
      .where(eq(agentTradingAccounts.agentId, context.agentId));
    await expect(context.db.update(agentTradingAccounts).set({ lastNonce: 99 })).rejects.toThrow();
    await expect(
      context.db.update(agentTradingAccounts).set({ derivationIndex: account.derivationIndex + 1 }),
    ).rejects.toThrow();
    await expect(
      context.db
        .update(agentTradingAccounts)
        .set({ perpAddress: "0x2222222222222222222222222222222222222222" }),
    ).rejects.toThrow();
    await expect(context.db.delete(agentTradingAccounts)).rejects.toThrow();
    await expect(
      context.db.update(tradingAccounts).set({ backupVersion: 1 }).where(eq(tradingAccounts.id, root.id)),
    ).rejects.toThrow();
  });
  it("rejects derivation outside the backed-up address range", () => {
    expect(() => derivePerpsWallet(`0x${"1".repeat(64)}`, -1)).toThrow();
    expect(() => derivePerpsWallet(`0x${"1".repeat(64)}`, 1000)).toThrow();
    expect(derivePerpsWallet(`0x${"1".repeat(64)}`, 999).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
