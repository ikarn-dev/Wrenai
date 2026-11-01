import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { executeIntentsAction } from "@/server/execution/intents-executor";
import { readPreparedOrder } from "@/server/execution/intents-order";
import { reconcileIntentsAction } from "@/server/execution/intents-reconciliation";
import { claimExecution, releaseExecutionLease } from "@/server/execution/ownership";
import { databaseTime, ownedExecution } from "@/server/execution/records";
import { cancelReservedExecution } from "@/server/execution/reservations";

export async function advanceIntentsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  mode: "execute" | "reconcile_only" = "execute",
): Promise<number> {
  const action = await ownedExecution(db, userId, actionId);
  const now = await databaseTime(db);
  if (action.status === "settled") {
    await reconcileIntentsAction(db, userId, actionId, "");
    return 60;
  }
  if (action.status === "cancelled") {
    return 60;
  }
  if (action.status === "reserved" && action.expiresAt <= now) {
    await cancelReservedExecution(db, userId, actionId);
    return 60;
  }
  if (action.status === "reserved" && (action.approvedAt === null || mode === "reconcile_only")) {
    return 60;
  }
  if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
    return 5;
  }
  let worker: Awaited<ReturnType<typeof claimExecution>> | null = null;
  try {
    worker = await claimExecution(db, userId, actionId);
    if (worker.mode === "submit") {
      await executeIntentsAction(db, userId, actionId, worker.token);
    }
    const result = await reconcileIntentsAction(db, userId, actionId, worker.token);
    if (
      result === "pending" &&
      mode === "execute" &&
      Date.parse((await readPreparedOrder(db, action)).providerDeadline) <= (await databaseTime(db))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The provider deadline passed without final accounting. Funds remain reserved; reconcile the order before restarting.",
      );
    }
  } catch (error) {
    const current = await ownedExecution(db, userId, actionId);
    // Reserved proves no signature was exposed. Unknown/submitted actions are always retained for recovery.
    if (
      current.status === "reserved" &&
      error instanceof ExecutionError &&
      (worker !== null || (error.code !== "conflict" && error.code !== "lease_lost"))
    ) {
      await cancelReservedExecution(db, userId, actionId);
      return 60;
    }
    throw error;
  } finally {
    if (worker) {
      await releaseExecutionLease(db, userId, actionId, worker.token);
    }
  }
  return (await ownedExecution(db, userId, actionId)).reservationReleasedAt === null ? 5 : 60;
}
