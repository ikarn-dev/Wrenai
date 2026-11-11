import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { previewFifoLots } from "@/server/positions/lots";
import { tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError } from "./contracts";
import { settleDefiExecution } from "./defi-accounting";
import { defiPlanSchema } from "./defi-contracts";
import {
  confirmedStatusQuote,
  intentsStatusSchema,
  readIntentsProviderStatus,
} from "./intents-reconciliation";
import { quoteMicroUsd } from "./oneclick-quote";
import { paymentRecord, verifiedPaymentQuote } from "./payment-order";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, executionHash, ownedLedgerAction, requireLease } from "./records";

export const paymentTerminalSchema = z.strictObject({
  destination: z.enum(["confidential", "near_wallet"]).optional(),
  destinationTxHashes: z
    .array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/))
    .max(20)
    .optional(),
  amountIn: tokenUnitsSchema,
  amountOut: tokenUnitsSchema,
  refundedAmount: tokenUnitsSchema,
  status: z.enum(["SUCCESS", "REFUNDED"]),
  amountInUsd: z.string().nullable(),
  intentHashes: z.array(z.string()).min(1).max(100),
  occurredAt: z.number().int().positive(),
});

export async function reconcilePaymentAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await synchronizePrivateInventory(db, userId);
    }
    return "settled";
  }
  requireLease(action, token, await databaseTime(db));
  if (action.kind !== "defi" || !["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("not_ready", "Only an existing confidential payment may be reconciled.");
  }
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    saved = await paymentRecord(db, action);
  const cash = plan.cash[0];
  if (!cash) {
    throw new ExecutionError("conflict", "The payment input is missing.");
  }
  const account = z
    .object({ quoteRequest: z.object({ refundTo: z.string() }) })
    .parse(saved.order.providerQuote).quoteRequest.refundTo;
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(saved.order.depositAddress));
  verifiedPaymentQuote(
    action,
    {
      ...saved,
      order: {
        ...saved.order,
        providerQuote: confirmedStatusQuote(saved.order.providerQuote, status.quoteResponse),
      },
    },
    account,
    saved.order.quotedAt,
  );
  z.object({ quote: z.object({ depositAddress: z.literal(saved.order.depositAddress) }) }).parse(
    status.quoteResponse,
  );
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    return "pending";
  }
  const details = status.swapDetails,
    occurredAt = Date.parse(status.updatedAt);
  if (
    occurredAt > Date.now() + 1000 ||
    details.amountIn === undefined ||
    details.amountOut === undefined ||
    details.depositedAmount !== cash.maxDebitUnits ||
    details.refundedAmount === undefined ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(cash.maxDebitUnits) ||
    details.intentHashes.length === 0 ||
    BigInt(details.amountOut) > BigInt(saved.amountUnits) ||
    (BigInt(details.amountIn) === 0n) !== (BigInt(details.amountOut) === 0n) ||
    (status.status === "SUCCESS" && details.amountOut !== saved.amountUnits)
  ) {
    throw new ExecutionError(
      "not_ready",
      "The payment status does not fully account for its recipient amount, deposit and refund.",
    );
  }
  const evidence = paymentTerminalSchema.parse({
    ...(saved.destination === "near_wallet"
      ? {
          destination: "near_wallet",
          destinationTxHashes: details.destinationChainTxHashes?.map((tx) => tx.hash) ?? [],
        }
      : {}),
    amountIn: details.amountIn,
    amountOut: details.amountOut,
    refundedAmount: details.refundedAmount,
    status: status.status,
    amountInUsd: details.amountInUsd ?? null,
    intentHashes: details.intentHashes.toSorted(),
    occurredAt,
  });
  if (
    saved.destination === "near_wallet" &&
    BigInt(evidence.amountOut) > 0n &&
    (evidence.destinationTxHashes?.length === 0 ||
      new Set(evidence.destinationTxHashes).size !== evidence.destinationTxHashes?.length)
  ) {
    throw new ExecutionError(
      "not_ready",
      "The provider has not supplied unique public payout transaction references yet. Funds remain reserved.",
    );
  }
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedLedgerAction(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    const [previous] = await tx
      .select()
      .from(executionEvents)
      .where(and(eq(executionEvents.actionId, actionId), eq(executionEvents.kind, "payment_terminal")))
      .limit(1);
    if (previous && executionHash(JSON.parse(previous.detailJson)) !== executionHash(evidence)) {
      throw new ExecutionError("conflict", "A different terminal payment receipt was already recorded.");
    }
    if (!previous) {
      await executionEvent(tx, row, "payment_terminal", now, evidence);
    }
    const debit = BigInt(evidence.amountIn);
    if (debit === 0n) {
      if (status.status !== "REFUNDED" || details.refundedAmount !== cash.maxDebitUnits) {
        throw new ExecutionError("conflict", "Only a fully refunded payment may settle without a debit.");
      }
      await tx
        .update(executionActions)
        .set({
          status: "settled",
          settlementHash: executionHash(evidence),
          settlementReceiptId: `oneclick:${saved.order.depositAddress}`,
          settledAt: now,
          updatedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(executionActions.id, actionId));
      return;
    }
    const value = quoteMicroUsd(z.string().parse(details.amountInUsd), true);
    const lots = await previewFifoLots(tx, userId, action.agentId, "confidential", cash.assetId, debit);
    await settleDefiExecution(tx, userId, actionId, token, {
      providerEventId: `oneclick:${saved.order.depositAddress}`,
      riskDebitMicroUsd: value.toString(),
      feeMicroUsd: null,
      cash: [
        {
          assetId: cash.assetId,
          debitUnits: details.amountIn,
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: lots.principalMicroUsd.toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await synchronizePrivateInventory(db, userId);
  return "settled";
}
