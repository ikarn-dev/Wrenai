import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { applyPositionFill } from "@/server/positions/execution";
import { ExecutionError, fillReceiptSchema, settlementSchema } from "./contracts";
import { markInventoryUncertain } from "./inventory-state";
import { existingReceipt, insertReceipt } from "./receipts";
import {
  databaseTime,
  type ExecutionAction,
  executionEvent,
  executionHash,
  ownedExecution,
  requireLease,
} from "./records";

async function fillTotals(
  db: AppDatabase,
  actionId: string,
): Promise<{ input: bigint; output: bigint; value: bigint }> {
  const [row] = await db
    .select({
      input: sql<string>`coalesce(sum(${executionFills.inputUnits}), 0)::text`,
      output: sql<string>`coalesce(sum(${executionFills.outputUnits}), 0)::text`,
      value: sql<string>`coalesce(sum(${executionFills.inputValueMicroUsd}), 0)::text`,
    })
    .from(executionFills)
    .where(eq(executionFills.actionId, actionId));
  return {
    input: BigInt(row?.input ?? "0"),
    output: BigInt(row?.output ?? "0"),
    value: BigInt(row?.value ?? "0"),
  };
}

function requireReconcilable(action: ExecutionAction): void {
  if (action.status !== "submitting" && action.status !== "submitted" && action.status !== "unknown") {
    throw new ExecutionError(
      "conflict",
      "Only a possibly submitted action can receive new provider receipts.",
    );
  }
}

/** Adapter-verified finalized fills only. Receipt replay never credits another action or changes historical amounts. */
export async function recordExecutionFill(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  rawReceipt: unknown,
): Promise<void> {
  const receipt = fillReceiptSchema.parse(rawReceipt);
  const receiptHash = executionHash(receipt);
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedExecution(tx, userId, actionId);
    if (await existingReceipt(tx, action, receipt.providerEventId, receiptHash)) {
      return;
    }
    const [existing] = await tx
      .select()
      .from(executionFills)
      .where(
        and(
          eq(executionFills.userId, userId),
          eq(executionFills.scope, action.scope),
          eq(executionFills.providerEventId, receipt.providerEventId),
        ),
      )
      .limit(1);
    if (existing !== undefined) {
      if (existing.actionId !== actionId || existing.receiptHash !== receiptHash) {
        throw new ExecutionError(
          "conflict",
          "This provider receipt was already recorded for different fill data.",
        );
      }
      return;
    }
    const now = await databaseTime(tx);
    requireLease(action, token, now);
    requireReconcilable(action);
    if (
      action.startedAt === null ||
      (receipt.feeMicroUsd !== null && BigInt(receipt.feeMicroUsd) > BigInt(receipt.inputValueMicroUsd))
    ) {
      throw new ExecutionError(
        "conflict",
        "The included fee or submission state is inconsistent with this fill.",
      );
    }
    const totals = await fillTotals(tx, actionId);
    if (
      totals.input + BigInt(receipt.inputUnits) > action.inputUnits ||
      totals.value + BigInt(receipt.inputValueMicroUsd) > action.notionalMicroUsd
    ) {
      throw new ExecutionError(
        "limit",
        "The receipts exceed the reserved input or cost ceiling. Keep this action quarantined for reconciliation.",
      );
    }
    const id = await insertReceipt(
      tx,
      action,
      receipt.providerEventId,
      receipt,
      BigInt(receipt.inputValueMicroUsd),
      now,
    );
    const [fill] = await tx
      .insert(executionFills)
      .values({
        id,
        userId,
        actionId,
        scope: action.scope,
        providerEventId: receipt.providerEventId,
        receiptHash,
        inputUnits: BigInt(receipt.inputUnits),
        outputUnits: BigInt(receipt.outputUnits),
        inputValueMicroUsd: BigInt(receipt.inputValueMicroUsd),
        outputValueMicroUsd:
          receipt.outputValueMicroUsd === undefined ? null : BigInt(receipt.outputValueMicroUsd),
        feeMicroUsd: receipt.feeMicroUsd === null ? null : BigInt(receipt.feeMicroUsd),
        occurredAt: receipt.occurredAt,
        recordedAt: now,
      })
      .returning();
    if (fill === undefined) {
      throw new Error("The fill was not stored.");
    }
    await applyPositionFill(tx, action, fill);
    await markInventoryUncertain(tx, action);
    await executionEvent(tx, action, "fill_recorded", now, {
      providerEventId: receipt.providerEventId,
      receiptHash,
    });
  });
}

/** A terminal adapter receipt must account for every reserved input unit: filled or refunded. */
export async function settleExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  rawSettlement: unknown,
): Promise<void> {
  const receipt = settlementSchema.parse(rawSettlement);
  const settlementHash = executionHash(receipt);
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedExecution(tx, userId, actionId);
    if (action.status === "settled") {
      if (action.settlementHash !== settlementHash) {
        throw new ExecutionError("conflict", "A different terminal receipt was already recorded.");
      }
      return;
    }
    const [used] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.scope, action.scope),
          eq(executionActions.settlementReceiptId, receipt.providerReceiptId),
        ),
      )
      .limit(1);
    if (used !== undefined) {
      throw new ExecutionError("conflict", "This terminal provider receipt belongs to another action.");
    }
    const now = await databaseTime(tx);
    requireLease(action, token, now);
    requireReconcilable(action);
    const totals = await fillTotals(tx, actionId);
    if (totals.input + BigInt(receipt.refundedInputUnits) !== action.inputUnits) {
      throw new ExecutionError(
        "conflict",
        "Filled and refunded input must exactly account for the reservation.",
      );
    }
    // Partial-fill minimum rounds up against risk, without converting token amounts to floats.
    const minimum = (action.minOutputUnits * totals.input + action.inputUnits - 1n) / action.inputUnits;
    if (totals.output < minimum) {
      throw new ExecutionError(
        "limit",
        "Confirmed output is below the bound price. Keep funds reserved for investigation.",
      );
    }
    await tx
      .update(executionActions)
      .set({
        status: "settled",
        settlementHash,
        settlementReceiptId: receipt.providerReceiptId,
        settledAt: now,
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(executionActions.id, action.id));
    await markInventoryUncertain(tx, action);
    await executionEvent(tx, action, "settled_awaiting_inventory", now, { ...receipt, settlementHash });
  });
}
