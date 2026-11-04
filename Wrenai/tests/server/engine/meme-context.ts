import providerFixture from "@tests/server/execution/oneclick-intent.fixture.json";
import { executionTestContext, startTestSubmission } from "@tests/server/execution/test-context";
import { cashAsset, hunterInstruction, memeAsset } from "@tests/server/squint/fixtures";
import { blockHash, poolId } from "@tests/server/squint/near-profile-fixture";
import { eq } from "drizzle-orm";
import { agentRuntimes, agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { initialInstructionState } from "@/server/engine/instruction-state";
import { initialMemeState, type MemeState } from "@/server/engine/meme-state";
import type { StrategyCheckPlan } from "@/server/engine/planning";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { executionEvent, executionHash } from "@/server/execution/records";
import { reserveExecution } from "@/server/execution/reservations";
import { assignInventory } from "@/server/positions/attribution";
import type { MemeEvidence } from "@/server/squint/near-profile-contracts";
import type { TradeQuote } from "@/shared/trade-preview";

export function memeEvidenceFixture(now: number): MemeEvidence {
  return {
    profile: "nearly-raw-v6-lock8",
    token: "fixture.nearlytrade.near",
    poolId,
    createdAt: now - 120000,
    observedAt: now,
    riskCheckedAt: now,
    reportHash: "a".repeat(64),
    blockHash,
    blockHeight: 123,
    liquidityNearUnits: "1000000000000000000000000000",
  };
}
export function memeStateFixture(now: number): MemeState {
  return {
    ...initialMemeState(executionHash(hunterInstruction(now))),
    positions: [
      {
        asset: memeAsset,
        assetHash: executionHash(memeAsset),
        evidence: memeEvidenceFixture(now),
        spot: initialInstructionState("spot_trader"),
      },
    ],
  };
}
export function memeQuote(now: number, changes: Partial<TradeQuote> = {}): TradeQuote {
  return {
    provider: "oneclick",
    scope: "confidential",
    inputAssetId: cashAsset.assetId,
    outputAssetId: memeAsset.assetId,
    inputUnits: "1000000000000000000000000",
    outputUnits: "2000000000000000000",
    minOutputUnits: "1990000000000000000",
    inputMicroUsd: "2000000",
    outputMicroUsd: "2000000",
    slippageBps: 50,
    appFeeBps: 0,
    capturedAt: now,
    expiresAt: now + 15000,
    quoteHash: "a".repeat(64),
    recipient: "owner.near",
    refundTo: "owner.near",
    feeNote: "Offline fixture",
    ...changes,
  };
}
export async function observeMemeInventory(
  db: AppDatabase,
  cashUnits: string,
  baseUnits: string,
): Promise<void> {
  const syncToken = await beginInventorySync(db, "owner", "confidential");
  await finishInventorySync(db, "owner", {
    scope: "confidential",
    syncToken,
    balances: [
      { assetId: cashAsset.assetId, amountUnits: cashUnits },
      { assetId: memeAsset.assetId, amountUnits: baseUnits },
    ],
  });
}
export async function memeTestContext(): Promise<
  Awaited<ReturnType<typeof executionTestContext>> & { instruction: ReturnType<typeof hunterInstruction> }
> {
  const context = await executionTestContext(
    {
      budgetUsd: "100",
      maxTradeUsd: "5",
      dailyCapUsd: "20",
      maxTradesPerHour: 60,
      allowRiskReducingExits: true,
    },
    {},
    false,
  );
  const instruction = hunterInstruction(Date.now());
  await context.db.update(agents).set({ pack: "meme_hunter" }).where(eq(agents.id, context.agentId));
  await context.db
    .update(strategyVersions)
    .set({
      configJson: JSON.stringify(instruction),
      resolvedAssetsJson: JSON.stringify({
        strategyHash: executionHash(instruction),
        metadataHash: executionHash([cashAsset]),
        assets: [{ symbol: cashAsset.assetId, assetId: cashAsset.assetId }],
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
  });
  await observeMemeInventory(context.db, "10000000000000000000000000", "0");
  await assignInventory(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "confidential",
    assetId: cashAsset.assetId,
    quantityUnits: "10000000000000000000000000",
    capitalMicroUsd: "20000000",
    costBasisMicroUsd: "20000000",
    sourceReference: "offline-hunter-allocation",
    evidenceHash: "a".repeat(64),
  });
  return { ...context, instruction };
}
export async function saveMemeState(db: AppDatabase, agentId: string, state: MemeState): Promise<void> {
  await db
    .update(agentRuntimes)
    .set({ strategyStateJson: JSON.stringify(state) })
    .where(eq(agentRuntimes.agentId, agentId));
}
/** Uses real Guard/reservations/accounting. The unsigned provider envelope is only read as receipt metadata. */
export async function reserveMemePlan(
  context: Awaited<ReturnType<typeof memeTestContext>>,
  plan: StrategyCheckPlan,
  reduceOnly = false,
): Promise<Awaited<ReturnType<typeof reserveExecution>>> {
  if (!plan.signal || !plan.requestId || plan.progress?.strategyState.format !== 6) {
    throw new Error("Expected a persisted hunter signal");
  }
  await saveMemeState(context.db, context.agentId, plan.progress.strategyState);
  const action = await reserveExecution(context.db, "owner", {
    requestId: plan.requestId,
    agentId: context.agentId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "per_agent",
    ...(reduceOnly ? { reduceOnly: true } : {}),
    scope: "confidential",
    inputAssetId: plan.signal.inputAssetId,
    outputAssetId: plan.signal.outputAssetId,
    inputUnits: plan.signal.inputUnits,
    minOutputUnits: reduceOnly ? "2990000000000000000000000" : "1990000000000000000",
    notionalMicroUsd: reduceOnly ? "6030000" : "5000000",
    slippageBps: 50,
    quoteId: crypto.randomUUID(),
    quoteHash: "a".repeat(64),
    expiresAt: Date.now() + 120000,
  });
  await executionEvent(context.db, action, "intents_prepared", Date.now(), {
    format: 1,
    signalHash: executionHash({
      ...plan.signal,
      requestId: plan.requestId,
      agentId: context.agentId,
      expectedRevision: 1,
    }),
    signal: { ...plan.signal, requestId: plan.requestId, agentId: context.agentId, expectedRevision: 1 },
    quotedAt: Date.now(),
    maximumProviderFeeBps: 0,
    requestDeadline: new Date(Date.now() + 120000).toISOString(),
    providerDeadline: new Date(Date.now() + 120000).toISOString(),
    providerQuote: {},
    generated: providerFixture.generated,
    payloadHash: "b".repeat(64),
    depositAddress: "c".repeat(64),
  });
  return action;
}
export async function fillMemeAction(
  context: Awaited<ReturnType<typeof memeTestContext>>,
  actionId: string,
  input: string,
  output: string,
  value: string,
  refund = "0",
): Promise<void> {
  const submission = await startTestSubmission(context.db, actionId);
  const receipt = {
    providerEventId: `fill:${actionId}`,
    inputUnits: input,
    outputUnits: output,
    inputValueMicroUsd: value,
    outputValueMicroUsd: value,
    feeMicroUsd: null,
    occurredAt: Date.now(),
  };
  await recordExecutionFill(context.db, "owner", actionId, submission.token, receipt);
  await recordExecutionFill(context.db, "owner", actionId, submission.token, receipt);
  await settleExecution(context.db, "owner", actionId, submission.token, {
    providerReceiptId: `settle:${actionId}`,
    refundedInputUnits: refund,
  });
}
