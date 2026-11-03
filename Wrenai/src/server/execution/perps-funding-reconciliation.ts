import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { previewFifoLots } from "@/server/positions/lots";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError } from "./contracts";
import { settleDefiExecution } from "./defi-accounting";
import { defiPlanSchema } from "./defi-contracts";
import { synchronizePerpsInventory } from "./hyperliquid/account-state";
import { intentsStatusSchema, readIntentsProviderStatus } from "./intents-reconciliation";
import { markInventoryUncertain } from "./inventory-state";
import { quoteMicroUsd } from "./oneclick-quote";
import { paymentTerminalSchema } from "./payment-reconciliation";
import { perpsFundingRecord, verifiedFundingQuote } from "./perps-funding-order";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, executionHash, ownedLedgerAction, requireLease } from "./records";

async function refreshFundingLocations(db: AppDatabase, userId: string, agentId: string): Promise<void> {
  await synchronizePrivateInventory(db, userId);
  await synchronizePerpsInventory(db, userId, agentId);
}
export async function reconcilePerpsFunding(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (!plan.funding) {
    throw new ExecutionError("conflict", "This is not an owned-account funding action.");
  }
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await refreshFundingLocations(db, userId, action.agentId);
    }
    return "settled";
  }
  requireLease(action, token, await databaseTime(db));
  if (!["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("not_ready", "Only a possibly submitted venue deposit can be reconciled.");
  }
  const saved = await perpsFundingRecord(db, action),
    source = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    destination = plan.cash.find((cash) => cash.scope === "hyperliquid");
  if (!source || !destination) {
    throw new ExecutionError("conflict", "The funding account locations are missing.");
  }
  const owner = z
    .object({ quoteRequest: z.object({ refundTo: z.string() }) })
    .parse(saved.order.providerQuote).quoteRequest.refundTo;
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(saved.order.depositAddress));
  verifiedFundingQuote(
    action,
    { ...saved, order: { ...saved.order, providerQuote: status.quoteResponse } },
    owner,
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
    details.refundedAmount === undefined ||
    details.depositedAmount !== source.maxDebitUnits ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(source.maxDebitUnits) ||
    details.intentHashes.length === 0 ||
    (BigInt(details.amountIn) === 0n) !== (BigInt(details.amountOut) === 0n) ||
    (status.status === "SUCCESS" && BigInt(details.amountOut) / 100n < BigInt(destination.minCreditUnits))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The venue deposit does not fully account for its source, destination and refund.",
    );
  }
  const [ack] = await db
    .select()
    .from(executionEvents)
    .where(and(eq(executionEvents.actionId, action.id), eq(executionEvents.kind, "perps_funding_submitted")))
    .limit(1);
  if (
    ack &&
    !details.intentHashes.includes(
      z.object({ intentHash: z.string() }).parse(JSON.parse(ack.detailJson)).intentHash,
    )
  ) {
    throw new ExecutionError("conflict", "The funding receipt excludes its acknowledged transfer.");
  }
  const evidence = paymentTerminalSchema.parse({
    amountIn: details.amountIn,
    amountOut: details.amountOut,
    refundedAmount: details.refundedAmount,
    status: status.status,
    amountInUsd: details.amountInUsd ?? null,
    intentHashes: details.intentHashes.toSorted(),
    occurredAt,
  });
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedLedgerAction(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    const debit = BigInt(evidence.amountIn),
      credit = BigInt(evidence.amountOut) / 100n;
    await executionEvent(tx, row, "perps_funding_terminal", now, evidence);
    if (debit === 0n) {
      if (status.status !== "REFUNDED" || evidence.refundedAmount !== source.maxDebitUnits) {
        throw new ExecutionError("conflict", "A zero-debit deposit must be fully refunded.");
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
      await markInventoryUncertain(tx, action);
      return;
    }
    const value = quoteMicroUsd(z.string().parse(evidence.amountInUsd), true),
      creditValue =
        (quoteMicroUsd(z.string().parse(details.amountOutUsd), false) * credit * 100n) /
        BigInt(evidence.amountOut);
    const lots = await previewFifoLots(tx, userId, action.agentId, "confidential", source.assetId, debit);
    const transferredPrincipal = minimumUnits(lots.principalMicroUsd, creditValue);
    if (credit <= 0n) {
      throw new ExecutionError("not_ready", "The bridge output is below one complete venue cash unit.");
    }
    await settleDefiExecution(tx, userId, actionId, token, {
      ...(status.status === "REFUNDED" && BigInt(evidence.refundedAmount) > 0n
        ? { fundingRefund: true }
        : {}),
      providerEventId: `oneclick:${saved.order.depositAddress}`,
      riskDebitMicroUsd: value.toString(),
      feeMicroUsd: null,
      cash: [
        {
          assetId: source.assetId,
          debitUnits: debit.toString(),
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
        {
          assetId: destination.assetId,
          debitUnits: "0",
          creditUnits: credit.toString(),
          creditValueMicroUsd: creditValue.toString(),
          creditPrincipalMicroUsd: transferredPrincipal.toString(),
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: (lots.principalMicroUsd - transferredPrincipal).toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await refreshFundingLocations(db, userId, action.agentId);
  return "settled";
}
