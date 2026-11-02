import { executionTestContext, startTestSubmission } from "@tests/server/execution/test-context";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimes, agents, strategyVersions } from "@/server/db/agent-schema";
import { initialInstructionState } from "@/server/engine/instruction-state";
import { recordExecutionFill } from "@/server/execution/accounting";
import type { ExecutionPlan } from "@/server/execution/contracts";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { executionHash } from "@/server/execution/records";
import { reserveExecution } from "@/server/execution/reservations";
import { readSpendingUsage } from "@/server/execution/usage";
import { assignInventory } from "@/server/positions/attribution";
import { agentInstructionSchema } from "@/shared/agent-instructions";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
const base = "nep141:wrap.near",
  cash = "nep141:usdc.test-fixture.near";
const holding = {
  ...initialInstructionState("spot_trader"),
  phase: "holding" as const,
  quantityUnits: "2000000",
  runs: 1,
  exitTriggered: true,
};
beforeEach(async () => {
  context = await executionTestContext(
    { budgetUsd: "100", maxTradeUsd: "1", dailyCapUsd: "1", allowRiskReducingExits: true },
    {},
    false,
  );
  const instruction = agentInstructionSchema.parse({
    format: 2,
    kind: "spot_trader",
    side: "buy",
    payAssetId: cash,
    buyAssetId: base,
    priceUnit: "usd",
    amountUnits: "1000000",
    entry: { type: "market" },
    exits: { takeProfitPrice: "10", stopLossPrice: "1", trailingStopBps: null },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await context.db.update(agents).set({ pack: "spot_trader" }).where(eq(agents.id, context.agentId));
  await context.db
    .update(strategyVersions)
    .set({
      configJson: JSON.stringify(instruction),
      resolvedAssetsJson: JSON.stringify({
        strategyHash: executionHash(instruction),
        assets: [
          { symbol: base, assetId: base },
          { symbol: cash, assetId: cash },
        ],
      }),
    })
    .where(eq(strategyVersions.agentId, context.agentId));
  await context.db.insert(agentRuntimes).values({
    userId: "owner",
    agentId: context.agentId,
    activationId: crypto.randomUUID(),
    inputHash: "a".repeat(64),
    agentRevision: 1,
    strategyVersion: 1,
    state: "active",
    nextCheckAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    strategyStateJson: JSON.stringify(holding),
  });
  const syncToken = await beginInventorySync(context.db, "owner", "confidential");
  await finishInventorySync(context.db, "owner", {
    scope: "confidential",
    syncToken,
    balances: [{ assetId: base, amountUnits: "2000000" }],
  });
  await assignInventory(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "confidential",
    assetId: base,
    quantityUnits: "2000000",
    capitalMicroUsd: "20000000",
    costBasisMicroUsd: "20000000",
    sourceReference: "offline-owned-position",
    evidenceHash: "a".repeat(64),
  });
});
afterEach(async () => context.postgres.close());
function exit(fields: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "per_agent",
    reduceOnly: true,
    scope: "confidential",
    inputAssetId: base,
    outputAssetId: cash,
    inputUnits: "1000000",
    minOutputUnits: "1000000",
    notionalMicroUsd: "20000000",
    slippageBps: 50,
    quoteId: crypto.randomUUID(),
    quoteHash: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
    ...fields,
  };
}
describe("independently verified position-reducing exits", () => {
  it("can exit above the entry/day cap without charging the exit as new risk", async () => {
    const action = await reserveExecution(context.db, "owner", exit());
    const pending = await readSpendingUsage(context.db, "owner", context.agentId, Date.now());
    expect(pending.agentPendingMicroUsd).toBe(0n);
    const submission = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, submission.token, {
      providerEventId: "offline-exit-fill",
      inputUnits: "1000000",
      outputUnits: "20000000",
      inputValueMicroUsd: "20000000",
      feeMicroUsd: null,
      occurredAt: Date.now(),
    });
    expect(
      (await readSpendingUsage(context.db, "owner", context.agentId, Date.now())).agentSpent24hMicroUsd,
    ).toBe(0n);
  });
  it("rejects direction changes, excess quantities and an untriggered protection rule", async () => {
    await expect(
      reserveExecution(context.db, "owner", exit({ inputAssetId: cash, outputAssetId: base })),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      reserveExecution(context.db, "owner", exit({ inputUnits: "2000001" })),
    ).rejects.toMatchObject({ code: "limit" });
    await context.db
      .update(agentRuntimes)
      .set({ strategyStateJson: JSON.stringify({ ...holding, exitTriggered: false }) })
      .where(eq(agentRuntimes.agentId, context.agentId));
    await expect(reserveExecution(context.db, "owner", exit())).rejects.toMatchObject({ code: "not_ready" });
  });
  it("keeps fee limits and actual inventory reservations enforced on protective exits", async () => {
    await expect(reserveExecution(context.db, "owner", exit({ slippageBps: 51 }))).rejects.toMatchObject({
      code: "limit",
    });
    await reserveExecution(context.db, "owner", exit({ inputUnits: "1500000" }));
    await expect(
      reserveExecution(context.db, "owner", exit({ inputUnits: "1000000" })),
    ).rejects.toMatchObject({ code: "limit" });
  });
  it("does not grant the exception to policies that did not opt in", async () => {
    const [row] = await context.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, context.agentId), eq(agents.userId, "owner")))
      .limit(1);
    if (!row) {
      throw new Error("Missing fixture agent");
    }
    const { policySchema } = await import("@/shared/agents");
    const policy = policySchema.parse(JSON.parse(row.policyJson));
    await context.db
      .update(agents)
      .set({ policyJson: JSON.stringify({ ...policy, allowRiskReducingExits: false }) })
      .where(eq(agents.id, context.agentId));
    await expect(reserveExecution(context.db, "owner", exit())).rejects.toMatchObject({ code: "not_ready" });
  });
});
