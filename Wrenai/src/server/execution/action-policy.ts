import "server-only";
import type { AppDatabase } from "@/server/db/client";
import type { AgentPolicy } from "@/shared/agents";
import { ExecutionError, executionPlanSchema } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { currentDefiPolicy } from "./defi-policy";
import { availableInventory } from "./inventory";
import { checkReservationLimits, checkSubmissionRate, recheckExecution } from "./policy";
import { type LedgerAction, swapAction } from "./records";

export async function recheckLedgerAction(
  db: AppDatabase,
  action: LedgerAction,
  now: number,
  mode: "claim" | "submit",
): Promise<AgentPolicy> {
  if (action.kind === "swap") {
    const swap = swapAction(action);
    const plan = executionPlanSchema.parse(JSON.parse(swap.planJson));
    const current = await recheckExecution(db, swap, plan, now);
    if (mode === "claim") {
      return current.policy;
    }
    await checkReservationLimits(db, action.userId, plan, current, now, action.id);
    await checkSubmissionRate(db, action, current.policy, now, current.riskReducingExit);
    if ((await availableInventory(db, action.userId, action.scope, swap.inputAssetId, now)) < 0n) {
      throw new ExecutionError("insufficient_funds", "Current inventory no longer covers its reservations.");
    }
    return current.policy;
  }
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  const current = await currentDefiPolicy(db, action.userId, plan, now, action);
  if (mode === "claim") {
    return current.policy;
  }
  await checkSubmissionRate(db, action, current.policy, now, current.riskReducingExit);
  for (const cash of plan.cash) {
    if ((await availableInventory(db, action.userId, cash.scope ?? action.scope, cash.assetId, now)) < 0n) {
      throw new ExecutionError(
        "insufficient_funds",
        "Current inventory no longer covers every reserved asset.",
      );
    }
  }
  return current.policy;
}
