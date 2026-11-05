import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { parseUsd, policySchema } from "@/shared/agents";
import { currentAgentStrategy } from "./asset-review";
import { privateBalanceToken } from "./balance-session";
import { ExecutionError, executionPlanSchema } from "./contracts";
import { swapGuardVerdict } from "./guard-swap";
import { instructionSubmissionCheck } from "./instruction-reference";
import { prepareIntentsOrder } from "./intents-quote";
import { preparedOrderSchema, swapSignalSchema } from "./intents-record";
import { dryQuoteRequest, verifiedProviderQuote } from "./oneclick-quote";
import { databaseTime, type ExecutionAction, executionEvent, executionHash, ownedExecution } from "./records";
import { reserveExecution } from "./reservations";
import { checkStrategyAssets } from "./strategy-assets";

export { preparedOrderSchema, swapSignalSchema } from "./intents-record";

export async function readPreparedOrder(
  db: AppDatabase,
  action: ExecutionAction,
): Promise<z.infer<typeof preparedOrderSchema>> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "intents_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "This action has no unique immutable Intents preparation record.");
  }
  return preparedOrderSchema.parse(JSON.parse(rows[0].detailJson));
}

/** Internal deterministic strategy signal only. The Signer independently revalidates these provider artifacts. */
export async function prepareSwapExecution(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ExecutionAction> {
  const signal = swapSignalSchema.parse(raw);
  const signalHash = executionHash(signal);
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, signal.requestId)))
    .limit(1);
  if (existing) {
    const action = await ownedExecution(db, userId, existing.id);
    if ((await readPreparedOrder(db, action)).signalHash !== signalHash) {
      throw new ExecutionError("conflict", "This signal already belongs to a different trade.");
    }
    return action;
  }
  const current = await currentAgentStrategy(db, userId, signal.agentId, signal.expectedRevision);
  const agent = current.agent;
  if (agent.revision !== signal.expectedRevision || agent.status !== "running") {
    throw new ExecutionError("not_ready", "A current running agent is required for execution.");
  }
  const policy = policySchema.parse(JSON.parse(agent.policyJson));
  if (
    agent.pack === "copy_trading"
      ? signal.purpose !== "copy_trade" || signal.copyTrade === undefined
      : signal.purpose === "copy_trade" || signal.copyTrade !== undefined
  ) {
    throw new ExecutionError("not_ready", "The strategy requires its own verified execution signal.");
  }
  await checkStrategyAssets(db, {
    agentId: agent.id,
    strategyVersion: agent.version,
    inputAssetId: signal.inputAssetId,
    outputAssetId: signal.outputAssetId,
    inputUnits: signal.inputUnits,
  });
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) {
    throw new ExecutionError("not_ready", "The account is unavailable.");
  }
  const sessionToken = await privateBalanceToken(db, userId);
  if (!sessionToken) {
    throw new ExecutionError(
      "not_ready",
      "Connect the private balance before preparing a confidential order.",
    );
  }
  const order = await prepareIntentsOrder(
    {
      accountId: owner.accountId,
      inputAssetId: signal.inputAssetId,
      outputAssetId: signal.outputAssetId,
      inputUnits: signal.inputUnits,
      slippageBps: policy.maxSlippageBps,
      maximumProviderFeeBps: policy.maxProviderFeeBps,
    },
    undefined,
    sessionToken,
  );
  const checkInstruction = await instructionSubmissionCheck(db, current, signal, order.quote);
  const quoteEnvelope = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  const plan = executionPlanSchema.parse({
    requestId: signal.requestId,
    agentId: signal.agentId,
    agentRevision: agent.revision,
    strategyVersion: agent.version,
    budgetMode: "per_agent",
    riskPolicyRevision: 0,
    ...(signal.purpose === "instruction_exit" && policy.allowRiskReducingExits === true
      ? { reduceOnly: true }
      : {}),
    scope: "confidential",
    inputAssetId: signal.inputAssetId,
    outputAssetId: signal.outputAssetId,
    inputUnits: signal.inputUnits,
    minOutputUnits: order.quote.minOutputUnits,
    // Hold the full per-trade ceiling until the actual final debit is known.
    notionalMicroUsd:
      signal.purpose === "instruction_exit" &&
      policy.allowRiskReducingExits === true &&
      order.quote.inputMicroUsd !== null
        ? (
            (BigInt(order.quote.inputMicroUsd) * BigInt(10_000 + policy.maxSlippageBps) + 9999n) /
            10_000n
          ).toString()
        : parseUsd(policy.maxTradeUsd).toString(),
    slippageBps: policy.maxSlippageBps,
    providerFeeBps: order.quote.appFeeBps,
    quoteId: order.depositAddress,
    quoteHash: order.quote.quoteHash,
    expiresAt: order.quote.expiresAt,
  });
  if (BigInt(order.quote.inputMicroUsd ?? "0") > BigInt(plan.notionalMicroUsd)) {
    throw new ExecutionError("limit", "The quote exceeds your per-trade spending allowance.");
  }
  if (signal.referenceInputMicroUsd !== undefined) {
    const reference = BigInt(signal.referenceInputMicroUsd);
    const difference = BigInt(order.quote.inputMicroUsd ?? "0") - reference;
    if ((difference < 0n ? -difference : difference) * 10_000n > reference * BigInt(policy.maxSlippageBps)) {
      throw new ExecutionError(
        "not_ready",
        "The fresh quote moved beyond the strategy's reference-price tolerance.",
      );
    }
  }
  if (signal.referenceOutputPriceMicroUsd !== undefined && signal.outputDecimals !== undefined) {
    const outputValue =
      (BigInt(order.quote.outputUnits) * BigInt(signal.referenceOutputPriceMicroUsd)) /
      10n ** BigInt(signal.outputDecimals);
    const inputValue = BigInt(order.quote.inputMicroUsd ?? "0");
    if (inputValue <= 0n || outputValue * 10_000n < inputValue * BigInt(10_000 - policy.maxSlippageBps)) {
      throw new ExecutionError(
        "not_ready",
        "The executable route moved beyond the independent output-price tolerance.",
      );
    }
  }
  const prepared = preparedOrderSchema.parse({
    format: 1,
    signalHash,
    signal,
    quotedAt: order.quote.capturedAt,
    maximumProviderFeeBps: policy.maxProviderFeeBps,
    requestDeadline: quoteEnvelope.quoteRequest.deadline,
    providerDeadline: quoteEnvelope.quote.deadline,
    providerQuote: order.providerQuote,
    generated: order.generated,
    payloadHash: order.payloadHash,
    depositAddress: order.depositAddress,
  });
  return userTransaction(db, userId, async (tx) => {
    const [repeated] = await tx
      .select()
      .from(executionActions)
      .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, signal.requestId)))
      .limit(1);
    if (repeated) {
      const action = await ownedExecution(tx, userId, repeated.id);
      if ((await readPreparedOrder(tx, action)).signalHash !== signalHash) {
        throw new ExecutionError("conflict", "This signal already belongs to a different trade.");
      }
      return action;
    }
    const [unresolved] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.agentId, signal.agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (unresolved) {
      throw new ExecutionError(
        "conflict",
        "Reconcile this agent's existing action before preparing another trade.",
      );
    }
    await checkInstruction?.(tx);
    const verdict = await swapGuardVerdict(tx, userId, plan, await databaseTime(tx));
    if (verdict.status === "blocked") {
      throw new ExecutionError("limit", verdict.reason);
    }
    const action = await reserveExecution(tx, userId, plan);
    const [record] = await tx
      .select({ id: executionEvents.id })
      .from(executionEvents)
      .where(and(eq(executionEvents.actionId, action.id), eq(executionEvents.kind, "intents_prepared")))
      .limit(1);
    if (!record) {
      await executionEvent(tx, action, "intents_prepared", await databaseTime(tx), prepared);
    }
    return action;
  });
}

export function verifiedStoredQuote(
  action: ExecutionAction,
  prepared: z.infer<typeof preparedOrderSchema>,
  accountId: string,
  now: number,
): ReturnType<typeof verifiedProviderQuote> {
  const plan = executionPlanSchema.parse(JSON.parse(action.planJson));
  const request = {
    ...dryQuoteRequest(
      accountId,
      plan.inputAssetId,
      plan.outputAssetId,
      plan.inputUnits,
      plan.slippageBps,
      "confidential",
      prepared.quotedAt,
    ),
    dry: false,
    deadline: prepared.requestDeadline,
  };
  const quote = verifiedProviderQuote(prepared.providerQuote, request, "confidential", now, plan.slippageBps);
  if (
    quote.quoteHash !== plan.quoteHash ||
    quote.minOutputUnits !== plan.minOutputUnits ||
    BigInt(quote.inputMicroUsd ?? "0") > action.notionalMicroUsd ||
    quote.appFeeBps > prepared.maximumProviderFeeBps
  ) {
    throw new ExecutionError("conflict", "The signing quote differs from its reserved plan.");
  }
  return quote;
}
