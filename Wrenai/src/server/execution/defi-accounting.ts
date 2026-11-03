import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiDisposals, defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots, positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { consumeFifoLots } from "@/server/positions/lots";
import { ExecutionError } from "./contracts";
import { type DefiPlan, type DefiReceipt, defiPlanSchema, defiReceiptSchema } from "./defi-contracts";
import { markInventoryUncertain } from "./inventory-state";
import { existingReceipt, insertReceipt } from "./receipts";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
  requireLease,
} from "./records";

function validateReceipt(plan: DefiPlan, receipt: DefiReceipt): void {
  const fundingInput = plan.funding ? plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n) : undefined;
  const fundingDebit = fundingInput
    ? receipt.cash.find((cash) => cash.assetId === fundingInput.assetId)
    : undefined;
  if (
    receipt.fundingRefund &&
    (!fundingInput || !fundingDebit || BigInt(fundingDebit.debitUnits) >= BigInt(fundingInput.maxDebitUnits))
  ) {
    throw new ExecutionError(
      "conflict",
      "A partial funding refund must return some of its reserved source units.",
    );
  }
  if (
    receipt.cash.length !== plan.cash.length ||
    receipt.positions.length !== plan.positions.length ||
    new Set(receipt.cash.map((a) => a.assetId)).size !== receipt.cash.length ||
    new Set(receipt.positions.map((p) => p.positionId)).size !== receipt.positions.length ||
    (!plan.reduceOnly && BigInt(receipt.riskDebitMicroUsd) > BigInt(plan.notionalMicroUsd)) ||
    (receipt.feeMicroUsd !== null && BigInt(receipt.feeMicroUsd) > BigInt(receipt.riskDebitMicroUsd))
  ) {
    throw new ExecutionError("limit", "The final receipt exceeds its reserved risk or repeats a resource.");
  }
  const borrowed = BigInt(receipt.borrowedCapitalMicroUsd);
  const valuedCredits = receipt.cash.reduce((sum, cash) => sum + BigInt(cash.creditValueMicroUsd ?? "0"), 0n);
  if (
    (plan.operation !== "borrow" && borrowed !== 0n) ||
    (plan.operation === "borrow" &&
      (borrowed === 0n ||
        borrowed !== valuedCredits ||
        borrowed > BigInt(receipt.riskDebitMicroUsd) ||
        receipt.cash.some((cash) => cash.creditUnits !== "0" && cash.creditValueMicroUsd === null)))
  ) {
    throw new ExecutionError("conflict", "Borrowed proceeds require their full verified capital valuation.");
  }
  for (const cash of receipt.cash) {
    const bound = plan.cash.find((a) => a.assetId === cash.assetId);
    const minimumCredit =
      receipt.fundingRefund &&
      fundingInput &&
      fundingDebit &&
      bound?.scope !== undefined &&
      bound.scope !== plan.scope
        ? (BigInt(bound.minCreditUnits) *
            (BigInt(fundingDebit.debitUnits) - BigInt(plan.fundingFeeUnits ?? "0"))) /
          (BigInt(fundingInput.maxDebitUnits) - BigInt(plan.fundingFeeUnits ?? "0"))
        : BigInt(bound?.minCreditUnits ?? "0");
    if (
      !bound ||
      (plan.fundingFeeUnits !== undefined &&
        fundingDebit &&
        BigInt(fundingDebit.debitUnits) < BigInt(plan.fundingFeeUnits)) ||
      BigInt(cash.debitUnits) > BigInt(bound.maxDebitUnits) ||
      BigInt(cash.creditUnits) < minimumCredit ||
      (cash.creditUnits === "0" && cash.creditPrincipalMicroUsd !== "0")
    ) {
      throw new ExecutionError(
        "limit",
        "The receipt includes an unapproved cash movement or misses minimum proceeds.",
      );
    }
  }
  for (const position of receipt.positions) {
    const bound = plan.positions.find((p) => p.positionId === position.positionId);
    if (
      !bound ||
      BigInt(position.afterUnits) < BigInt(bound.minAfterUnits) ||
      BigInt(position.afterUnits) > BigInt(bound.maxAfterUnits) ||
      ((bound.kind === "debt" ||
        bound.kind === "perp_long" ||
        bound.kind === "perp_short" ||
        position.afterUnits === "0") &&
        position.principalMicroUsd !== "0")
    ) {
      throw new ExecutionError("limit", "The receipt's position differs from the approved exposure bounds.");
    }
  }
}

async function debitCash(
  db: AppDatabase,
  action: LedgerAction,
  receipt: DefiReceipt,
  receiptId: string,
): Promise<bigint> {
  let principal = 0n;
  for (const cash of receipt.cash) {
    const debit = BigInt(cash.debitUnits);
    if (debit === 0n) {
      continue;
    }
    const [claim] = await db
      .select()
      .from(positionReservations)
      .where(
        and(eq(positionReservations.actionId, action.id), eq(positionReservations.assetId, cash.assetId)),
      )
      .limit(1);
    if (
      !claim ||
      claim.userId !== action.userId ||
      claim.agentId !== action.agentId ||
      claim.scope !== action.scope ||
      claim.heldUnits < debit
    ) {
      throw new ExecutionError(
        "conflict",
        "The finalized debit has no matching attributed asset reservation.",
      );
    }
    const consumed = await consumeFifoLots(
      db,
      action.userId,
      action.agentId,
      action.scope,
      cash.assetId,
      debit,
    );
    principal += consumed.principalMicroUsd;
    await db.insert(defiDisposals).values(
      consumed.entries.map((entry) => ({
        userId: action.userId,
        receiptId,
        lotId: entry.lotId,
        quantityUnits: entry.quantityUnits,
        basisMicroUsd: entry.basisMicroUsd,
        principalMicroUsd: entry.principalMicroUsd,
      })),
    );
    await db
      .update(positionReservations)
      .set({ heldUnits: claim.heldUnits - debit })
      .where(
        and(eq(positionReservations.actionId, action.id), eq(positionReservations.assetId, cash.assetId)),
      );
  }
  return principal;
}

async function updatePositions(
  db: AppDatabase,
  action: LedgerAction,
  plan: DefiPlan,
  receipt: DefiReceipt,
  receiptId: string,
  now: number,
): Promise<bigint> {
  let beforePrincipal = 0n;
  for (const position of receipt.positions) {
    const bound = plan.positions.find((p) => p.positionId === position.positionId);
    if (!bound) {
      throw new ExecutionError("conflict", "The position is outside the action.");
    }
    const [before] = await db
      .select()
      .from(defiPositions)
      .where(eq(defiPositions.id, position.positionId))
      .limit(1);
    if (
      (before === undefined && bound.expectedVersion !== 0) ||
      (before !== undefined &&
        (before.userId !== action.userId ||
          before.agentId !== action.agentId ||
          before.scope !== action.scope ||
          before.venueId !== plan.venueId ||
          before.kind !== bound.kind ||
          before.instrumentId !== bound.instrumentId ||
          before.version !== bound.expectedVersion ||
          before.quantityUnits !== BigInt(bound.beforeUnits)))
    ) {
      throw new ExecutionError("conflict", "The finalized position does not match its prior version.");
    }
    beforePrincipal += before?.principalMicroUsd ?? 0n;
    const values = {
      quantityUnits: BigInt(position.afterUnits),
      principalMicroUsd: BigInt(position.principalMicroUsd),
      version: bound.expectedVersion + 1,
      receiptId,
      updatedAt: now,
    };
    if (before) {
      await db.update(defiPositions).set(values).where(eq(defiPositions.id, before.id));
    } else {
      await db.insert(defiPositions).values({
        id: position.positionId,
        userId: action.userId,
        agentId: action.agentId,
        scope: action.scope,
        venueId: plan.venueId,
        kind: bound.kind,
        instrumentId: bound.instrumentId,
        ...values,
      });
    }
  }
  return beforePrincipal;
}

/** Only an adapter-verified, terminal, fully reconciled receipt. Partial/unknown outcomes retain every claim. */
export async function settleDefiExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  raw: unknown,
): Promise<void> {
  const receipt = defiReceiptSchema.parse(raw);
  const receiptHash = executionHash(receipt);
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    if (action.kind !== "defi") {
      throw new ExecutionError("conflict", "A swap must use swap receipt accounting.");
    }
    if (await existingReceipt(tx, action, receipt.providerEventId, receiptHash)) {
      return;
    }
    const now = await databaseTime(tx);
    requireLease(action, token, now);
    if (action.startedAt === null || !["submitting", "submitted", "unknown"].includes(action.status)) {
      throw new ExecutionError("conflict", "Only a possibly submitted action can be finalized.");
    }
    const plan = defiPlanSchema.parse(JSON.parse(action.planJson));
    validateReceipt(plan, receipt);
    if (BigInt(receipt.borrowedCapitalMicroUsd) > action.capitalReservationMicroUsd) {
      throw new ExecutionError("limit", "Borrowed proceeds exceed their committed capital reservation.");
    }
    const receiptId = await insertReceipt(
      tx,
      action,
      receipt.providerEventId,
      receipt,
      BigInt(receipt.riskDebitMicroUsd),
      now,
      BigInt(receipt.borrowedCapitalMicroUsd),
    );
    const principal =
      BigInt(receipt.borrowedCapitalMicroUsd) +
      (await debitCash(tx, action, receipt, receiptId)) +
      (await updatePositions(tx, action, plan, receipt, receiptId, now));
    const afterPrincipal =
      receipt.cash.reduce((total, cash) => total + BigInt(cash.creditPrincipalMicroUsd), 0n) +
      receipt.positions.reduce((total, position) => total + BigInt(position.principalMicroUsd), 0n);
    if (principal !== afterPrincipal + BigInt(receipt.retiredPrincipalMicroUsd)) {
      throw new ExecutionError(
        "conflict",
        "The receipt creates or loses allocated principal without accounting for it.",
      );
    }
    for (const cash of receipt.cash) {
      if (cash.creditUnits === "0") {
        continue;
      }
      await tx.insert(positionLots).values({
        id: randomUUID(),
        userId,
        agentId: action.agentId,
        scope: plan.cash.find((bound) => bound.assetId === cash.assetId)?.scope ?? action.scope,
        assetId: cash.assetId,
        sourceId: receiptId,
        sourceKind: "receipt",
        initialUnits: BigInt(cash.creditUnits),
        remainingUnits: BigInt(cash.creditUnits),
        initialBasisMicroUsd: cash.creditValueMicroUsd === null ? null : BigInt(cash.creditValueMicroUsd),
        remainingBasisMicroUsd: cash.creditValueMicroUsd === null ? null : BigInt(cash.creditValueMicroUsd),
        initialPrincipalMicroUsd: BigInt(cash.creditPrincipalMicroUsd),
        remainingPrincipalMicroUsd: BigInt(cash.creditPrincipalMicroUsd),
        openedAt: now,
      });
    }
    await tx
      .update(executionActions)
      .set({
        status: "settled",
        settlementHash: receiptHash,
        settlementReceiptId: receipt.providerEventId,
        settledAt: now,
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(executionActions.id, actionId));
    await markInventoryUncertain(tx, action);
    await executionEvent(tx, action, "defi_settled_awaiting_inventory", now, { receiptId, receiptHash });
  });
}
