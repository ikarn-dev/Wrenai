import "server-only";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { readPreparedOrder } from "@/server/execution/intents-order";
import { ownedExecution } from "@/server/execution/records";
import type { TriggerState, TriggerStrategy } from "./trigger";

export async function applyTriggerReceipt(
  db: AppDatabase,
  userId: string,
  agentId: string,
  version: number,
  requestId: string,
  strategy: TriggerStrategy,
  previous: TriggerState,
): Promise<TriggerState | null> {
  const [slot] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  const actionId = previous.pendingActionId ?? slot?.id;
  if (!actionId) {
    return null;
  }
  const action = await ownedExecution(db, userId, actionId);
  if (
    action.agentId !== agentId ||
    action.strategyVersion !== version ||
    action.reservationReleasedAt === null
  ) {
    throw new ExecutionError(
      "not_ready",
      "The trigger order must be fully reconciled before another signal.",
    );
  }
  if (previous.lastActionId === actionId) {
    return { ...previous, pendingActionId: null };
  }
  const signal = (await readPreparedOrder(db, action)).signal;
  if (!signal?.purpose) {
    throw new ExecutionError("not_ready", "The trigger order has no immutable entry or exit binding.");
  }
  const fills = await db
    .select({ input: executionFills.inputUnits, output: executionFills.outputUnits })
    .from(executionFills)
    .where(and(eq(executionFills.userId, userId), eq(executionFills.actionId, actionId)))
    .limit(2);
  if (fills.length > 1) {
    throw new ExecutionError("conflict", "This trigger requires a unique terminal swap receipt.");
  }
  const filled = fills[0];
  const next = { ...previous, lastActionId: actionId, pendingActionId: null, confirmationSince: null };
  if (!filled) {
    return { ...next, needsReset: signal.purpose === "trigger_entry" || previous.needsReset };
  }
  if (signal.purpose === "trigger_entry") {
    if (previous.phase !== "waiting" || BigInt(previous.quantityUnits) !== 0n) {
      throw new ExecutionError("conflict", "An entry cannot replace an existing trigger position.");
    }
    return {
      ...next,
      phase: "holding",
      quantityUnits: filled.output.toString(),
      peakMicroUsd: signal.referenceOutputPriceMicroUsd ?? "0",
      exitTriggered: false,
    };
  }
  if (previous.phase !== "holding" || filled.input > BigInt(previous.quantityUnits)) {
    throw new ExecutionError("conflict", "The exit debit exceeds this trigger's confirmed position.");
  }
  const remainder = BigInt(previous.quantityUnits) - filled.input;
  return remainder > 0n
    ? { ...next, quantityUnits: remainder.toString() }
    : {
        ...next,
        phase: strategy.rearm ? "waiting" : "completed",
        quantityUnits: "0",
        peakMicroUsd: "0",
        needsReset: strategy.rearm,
        exitTriggered: false,
      };
}
