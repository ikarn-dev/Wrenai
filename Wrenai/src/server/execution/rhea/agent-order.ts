import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { policySchema } from "@/shared/agents";
import { currentAgentStrategy, resolvedInstructionAssets } from "../asset-review";
import { ExecutionError, executionPlanSchema } from "../contracts";
import { swapSignalSchema } from "../intents-order";
import { readMemeDecision } from "../meme-binding";
import { memeSubmissionCheck } from "../meme-reference";
import { databaseTime, type ExecutionAction, executionEvent, ownedExecution } from "../records";
import { reserveExecution } from "../reservations";
import { nativeTokenAsset, synchronizeNativeInventory } from "./inventory";
import { prepareRheaOrder, readRheaPrepared } from "./order";
import { rheaTradeQuote } from "./quote";

export async function prepareRheaAgentSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ExecutionAction> {
  const signal = swapSignalSchema.parse(raw);
  const [repeated] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, signal.requestId)))
    .limit(1);
  if (repeated) {
    const action = await ownedExecution(db, userId, repeated.id),
      saved = await readRheaPrepared(db, action);
    if (JSON.stringify(saved.signal) !== JSON.stringify(signal)) {
      throw new ExecutionError("conflict", "This native request belongs to another signal.");
    }
    return action;
  }
  const current = await currentAgentStrategy(db, userId, signal.agentId, signal.expectedRevision),
    instruction = current.strategy;
  if (
    instruction.kind !== "meme_hunter" ||
    signal.scope !== "native_near" ||
    current.agent.status !== "running"
  ) {
    throw new ExecutionError("not_ready", "A reviewed native hunter decision is required.");
  }
  const decision = await readMemeDecision(db, userId, signal.agentId, current.agent.version, instruction);
  if (!decision.position.native || instruction.payAssetId !== "nep141:wrap.near") {
    throw new ExecutionError("conflict", "This hunter position is not funded for the native wNEAR route.");
  }
  const cash = resolvedInstructionAssets(instruction, current.version.resolvedAssetsJson, [
    await nativeTokenAsset(instruction.payAssetId),
  ]).find((a) => a.assetId === instruction.payAssetId);
  if (!cash) {
    throw new ExecutionError("not_ready", "The native spending token is unavailable.");
  }
  const entry = signal.purpose === "instruction_entry",
    input = entry ? cash : decision.position.asset,
    output = entry ? decision.position.asset : cash,
    policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const prepared = {
    ...(await prepareRheaOrder(
      db,
      userId,
      input,
      output,
      signal.inputUnits,
      policy.maxSlippageBps,
      decision.position.evidence.poolId,
    )),
    signal,
  };
  await synchronizeNativeInventory(db, userId, [input.assetId, output.assetId]);
  const check = await memeSubmissionCheck(
    db,
    current,
    signal,
    rheaTradeQuote(prepared.quote, prepared.accountId),
  );
  const plan = executionPlanSchema.parse({
    requestId: signal.requestId,
    agentId: signal.agentId,
    agentRevision: current.agent.revision,
    strategyVersion: current.agent.version,
    riskPolicyRevision: 0,
    budgetMode: "per_agent",
    ...(!entry && policy.allowRiskReducingExits ? { reduceOnly: true } : {}),
    scope: "native_near",
    inputAssetId: input.assetId,
    outputAssetId: output.assetId,
    inputUnits: signal.inputUnits,
    minOutputUnits: prepared.quote.minimumOutputUnits,
    notionalMicroUsd: prepared.quote.inputMicroUsd,
    slippageBps: policy.maxSlippageBps,
    providerFeeBps: 0,
    quoteId: prepared.quote.poolId,
    quoteHash: prepared.quoteHash,
    expiresAt: prepared.quote.expiresAt,
  });
  return userTransaction(db, userId, async (tx) => {
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.scope, "native_near"),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (pending) {
      throw new ExecutionError("conflict", "Reconcile the current native transaction before another swap.");
    }
    await check(tx);
    const action = await reserveExecution(tx, userId, plan);
    await executionEvent(tx, action, "rhea_prepared", await databaseTime(tx), prepared);
    return action;
  });
}
