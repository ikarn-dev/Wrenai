import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { claimExecution, releaseExecutionLease } from "@/server/execution/ownership";
import { executePaymentAction } from "@/server/execution/payment-executor";
import { paymentRecord } from "@/server/execution/payment-order";
import { reconcilePaymentAction } from "@/server/execution/payment-reconciliation";
import { databaseTime, ownedLedgerAction } from "@/server/execution/records";
import { cancelReservedExecution } from "@/server/execution/reservations";
import { advanceRheaAction } from "@/server/execution/rhea/advance";
import { advanceWalletConversion } from "@/server/funding/advance";
import { advanceIntentsAction } from "./action";
import { advancePerpsAction } from "./perps-action";

export async function advanceLedgerAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  mode: "execute" | "reconcile_only" = "execute",
): Promise<number> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.kind === "swap" && action.scope === "native_near") {
    return advanceRheaAction(db, userId, actionId, mode);
  }
  if (action.kind === "swap") {
    return advanceIntentsAction(db, userId, actionId, mode);
  }
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (plan.walletFundingId) {
    return advanceWalletConversion(db, userId, actionId, mode);
  }
  if (plan.funding || (plan.scope === "hyperliquid" && plan.venueId === "hyperliquid")) {
    return advancePerpsAction(db, userId, actionId, mode);
  }
  if (
    plan.operation !== "transfer" ||
    plan.scope !== "confidential" ||
    plan.venueId !== "confidential-intents"
  ) {
    throw new ExecutionError("not_ready", "This action requires its verified venue recovery adapter.");
  }
  if (action.status === "settled") {
    await reconcilePaymentAction(db, userId, actionId, "");
    return 60;
  }
  if (action.status === "cancelled") {
    return 60;
  }
  const now = await databaseTime(db);
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
  let worker: Awaited<ReturnType<typeof claimExecution>> | null = null;
  try {
    worker = await claimExecution(db, userId, actionId);
    if (worker.mode === "submit") {
      await executePaymentAction(db, userId, actionId, worker.token);
    }
    const result = await reconcilePaymentAction(db, userId, actionId, worker.token);
    if (
      result === "pending" &&
      mode === "execute" &&
      Date.parse((await paymentRecord(db, action)).order.providerDeadline) <= (await databaseTime(db))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The payment deadline passed without final delivery or refund. Funds stay reserved; reconcile before restarting.",
      );
    }
  } catch (error) {
    const current = await ownedLedgerAction(db, userId, actionId);
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
  return (await ownedLedgerAction(db, userId, actionId)).reservationReleasedAt === null ? 5 : 60;
}
