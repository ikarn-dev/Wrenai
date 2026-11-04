import { createSecretKey } from "node:crypto";
import { createFundingAgent, fundingAsset, fundingTestContext } from "@tests/server/funding/context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fulfilSetupBudget } from "@/server/agents/setup-binding";
import { agents } from "@/server/db/agent-schema";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { readPortfolioPerformance } from "@/server/portfolio/performance";
import { manageAgentAllocation, readAgentAllocations } from "@/server/positions/allocation-management";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { committedCapital } from "@/server/positions/capital-records";
import { unreservedOwnedUnits } from "@/server/positions/lots";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    tokens: [{ assetId: fundingAsset, symbol: "USDC", decimals: 6, blockchain: "near" }],
  }),
}));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
let context: Awaited<ReturnType<typeof fundingTestContext>>;
const user = { id: "owner", accountId: "owner.near" };
async function observed(units = "5000000"): Promise<void> {
  const token = await beginInventorySync(context.db, user.id, "confidential");
  await finishInventorySync(context.db, user.id, {
    scope: "confidential",
    syncToken: token,
    balances: [{ assetId: fundingAsset, amountUnits: units }],
  });
}
beforeEach(async () => {
  context = await fundingTestContext();
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation(() => observed());
  await observed();
  await setAgentCapitalLimit(context.db, user.id, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    amountMicroUsd: "100000000",
  });
});
afterEach(async () => context.postgres.close());
async function funded(principal = "5000000"): Promise<void> {
  await assignInventory(context.db, user.id, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "confidential",
    assetId: fundingAsset,
    quantityUnits: "5000000",
    capitalMicroUsd: principal,
    costBasisMicroUsd: null,
    sourceReference: "offline-private-allocation",
    evidenceHash: "a".repeat(64),
  });
  await fulfilSetupBudget(context.db, user.id, context.agentId, fundingAsset, "5000000");
}
function request(targetAgentId: string | null = null, quantityUnits = "3000000") {
  return {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: 1,
    scope: "confidential",
    assetId: fundingAsset,
    quantityUnits,
    targetAgentId,
  };
}
describe("unused agent fund allocation", () => {
  it("reassigns exact owned units and principal once, including retry after a lost response", async () => {
    await funded();
    const target = await createFundingAgent(context.db),
      input = request(target);
    await manageAgentAllocation(context.db, user, input);
    await manageAgentAllocation(context.db, user, input);
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(2000000n);
    expect(await unreservedOwnedUnits(context.db, user.id, target, "confidential", fundingAsset)).toBe(
      3000000n,
    );
    expect(await committedCapital(context.db, user.id, target)).toBe(3000000n);
    expect(synchronizePrivateInventory).toHaveBeenCalledTimes(1);
    await expect(
      manageAgentAllocation(context.db, user, { ...input, targetAgentId: null }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await readPortfolioPerformance(context.db, user.id)).count).toBe(0);
  });
  it("can move zero-principal profits without inventing principal or historic purchase costs", async () => {
    await funded("0");
    const target = await createFundingAgent(context.db);
    await manageAgentAllocation(context.db, user, request(target));
    expect(await committedCapital(context.db, user.id, target)).toBe(0n);
    expect(await unreservedOwnedUnits(context.db, user.id, target, "confidential", fundingAsset)).toBe(
      3000000n,
    );
  });
  it("rolls back the release when the destination belongs to another owner", async () => {
    await funded();
    const target = await createFundingAgent(context.db, "stranger");
    await expect(manageAgentAllocation(context.db, user, request(target))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(5000000n);
  });
  it("refuses running agents and observed inventory shortfalls", async () => {
    await funded();
    await context.db.update(agents).set({ status: "running" }).where(eq(agents.id, context.agentId));
    await expect(manageAgentAllocation(context.db, user, request())).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(synchronizePrivateInventory).not.toHaveBeenCalled();
    await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
    vi.mocked(synchronizePrivateInventory).mockImplementation(() => observed("1"));
    await expect(manageAgentAllocation(context.db, user, request())).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await committedCapital(context.db, user.id, context.agentId)).toBe(5000000n);
  });
  it("releases all unused units to the available balance and clears the unused capital ceiling", async () => {
    await funded();
    expect(
      (await readAgentAllocations(context.db, user.id, context.agentId)).allocations[0]?.availableUnits,
    ).toBe("5000000");
    await manageAgentAllocation(context.db, user, request(null, "5000000"));
    expect((await readAgentAllocations(context.db, user.id, context.agentId)).allocations).toHaveLength(0);
    expect(await committedCapital(context.db, user.id, context.agentId)).toBe(0n);
  });
});
