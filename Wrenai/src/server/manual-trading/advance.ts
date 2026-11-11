import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { ExecutionError } from "@/server/execution/contracts";
import { readPerpsCheckpoint } from "@/server/execution/hyperliquid/checkpoint";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { ownedLedgerAction } from "@/server/execution/records";
import { cleanClosedManualOrders } from "./closed-orders";
import { advancePaymentTopUp } from "./payment-top-up";
import { manualEnvelope, ownedManualTrade } from "./record";

export async function advanceManualTrade(db: AppDatabase, userId: string, id: string): Promise<boolean> {
  let row = await ownedManualTrade(db, userId, id).catch((error: unknown) => {
    if (error instanceof ExecutionError && error.code === "not_found") {
      return null;
    }
    throw error;
  });
  if (row?.status !== "confirmed") {
    const progress = await advancePaymentTopUp(db, userId, id);
    if (progress !== "confirmed") {
      return progress === "waiting";
    }
    row = await ownedManualTrade(db, userId, id);
  }
  if (!row.actionId) {
    return false;
  }
  const envelope = manualEnvelope(row);
  await advanceLedgerAction(db, userId, row.actionId);
  const action = await ownedLedgerAction(db, userId, row.actionId);
  if (action.reservationReleasedAt === null) {
    return true;
  }
  if (envelope.kind !== "perps" || action.status !== "settled") {
    return false;
  }
  const checkpoint = await readPerpsCheckpoint(db, userId, row.subjectId);
  if (!checkpoint) {
    return false;
  }
  if (checkpoint.quantity === "0") {
    const entry =
      checkpoint.entryActionId === action.id
        ? action
        : await ownedLedgerAction(db, userId, checkpoint.entryActionId);
    return !(await cleanClosedManualOrders(db, entry, checkpoint));
  }
  if (envelope.prepared.role !== "entry" || checkpoint.entryActionId !== action.id) {
    return false;
  }
  await watchPerpsPosition(db, userId, row.subjectId, true);
  const updated = await readPerpsCheckpoint(db, userId, row.subjectId);
  if (!updated || updated.entryActionId !== action.id) {
    return false;
  }
  return updated.quantity !== "0" || !(await cleanClosedManualOrders(db, action, updated));
}
