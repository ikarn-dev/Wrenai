import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { claimExecution, releaseExecutionLease } from "@/server/execution/ownership";
import { databaseTime, ownedLedgerAction } from "@/server/execution/records";
import { cancelReservedExecution } from "@/server/execution/reservations";
import { executeWalletConversion, reconcileWalletConversion } from "./execution";

export async function advanceWalletConversion(
  db: AppDatabase,
  userId: string,
  actionId: string,
  mode: "execute" | "reconcile_only",
): Promise<number> {
  const action = await ownedLedgerAction(db, userId, actionId),
    now = await databaseTime(db);
  if (action.status === "cancelled") {
    return 60;
  }
  if (action.status === "settled") {
    await reconcileWalletConversion(db, userId, actionId, "");
    return action.reservationReleasedAt === null ? 5 : 60;
  }
  if (action.status === "reserved" && action.expiresAt <= now) {
    await cancelReservedExecution(db, userId, actionId);
    return 60;
  }
  if (action.status === "reserved" && (mode === "reconcile_only" || action.approvedAt === null)) {
    return 60;
  }
  if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
    return 5;
  }
  const worker = await claimExecution(db, userId, actionId);
  try {
    if (worker.mode === "submit") {
      await executeWalletConversion(db, userId, actionId, worker.token);
    }
    await reconcileWalletConversion(db, userId, actionId, worker.token);
  } finally {
    await releaseExecutionLease(db, userId, actionId, worker.token);
  }
  return (await ownedLedgerAction(db, userId, actionId)).reservationReleasedAt === null ? 5 : 60;
}
