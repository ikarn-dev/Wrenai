import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { executePerpsAction } from "@/server/execution/hyperliquid/executor";
import { reconcilePerpsAction } from "@/server/execution/hyperliquid/reconciliation";
import { executePerpsReturn } from "@/server/execution/hyperliquid/return-executor";
import { reconcilePerpsReturn } from "@/server/execution/hyperliquid/return-reconciliation";
import { claimExecution, releaseExecutionLease } from "@/server/execution/ownership";
import { executePerpsFunding } from "@/server/execution/perps-funding-executor";
import { reconcilePerpsFunding } from "@/server/execution/perps-funding-reconciliation";
import { databaseTime, ownedLedgerAction } from "@/server/execution/records";
import { cancelReservedExecution } from "@/server/execution/reservations";

export async function advancePerpsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  mode: "execute" | "reconcile_only",
): Promise<number> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  const reconcile = plan.returnFunds
    ? reconcilePerpsReturn
    : plan.funding
      ? reconcilePerpsFunding
      : (connection: AppDatabase, owner: string, id: string, token: string) =>
          reconcilePerpsAction(connection, owner, id, token, mode === "execute");
  if (action.status === "settled") {
    await reconcile(db, userId, actionId, "");
    return 5;
  }
  if (action.status === "cancelled") {
    return 5;
  }
  const now = await databaseTime(db);
  if (action.status === "reserved" && action.expiresAt <= now) {
    await cancelReservedExecution(db, userId, actionId);
    return 5;
  }
  if (action.status === "reserved" && (mode === "reconcile_only" || action.approvedAt === null)) {
    return 60;
  }
  if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
    return 5;
  }
  let worker: Awaited<ReturnType<typeof claimExecution>> | null = null;
  try {
    worker = await claimExecution(db, userId, actionId);
    if (worker.mode === "submit") {
      if (plan.returnFunds) {
        await executePerpsReturn(db, userId, actionId, worker.token);
      } else if (plan.funding) {
        await executePerpsFunding(db, userId, actionId, worker.token);
      } else {
        await executePerpsAction(db, userId, actionId, worker.token);
      }
    }
    if ((await ownedLedgerAction(db, userId, actionId)).status !== "reserved") {
      await reconcile(db, userId, actionId, worker.token);
    }
  } catch (error) {
    const current = await ownedLedgerAction(db, userId, actionId);
    if (
      current.status === "reserved" &&
      error instanceof ExecutionError &&
      (worker !== null || (error.code !== "conflict" && error.code !== "lease_lost"))
    ) {
      await cancelReservedExecution(db, userId, actionId);
      return 5;
    }
    throw error;
  } finally {
    if (worker) {
      await releaseExecutionLease(db, userId, actionId, worker.token);
    }
  }
  return 5;
}
