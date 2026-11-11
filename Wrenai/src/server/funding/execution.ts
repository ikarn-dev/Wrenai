import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { submitConfidentialTransfer } from "@/server/execution/confidential-transfer";
import { ExecutionError } from "@/server/execution/contracts";
import { settleDefiExecution } from "@/server/execution/defi-accounting";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import {
  confirmedStatusQuote,
  intentsStatusSchema,
  readIntentsProviderStatus,
} from "@/server/execution/intents-reconciliation";
import { markInventoryUncertain } from "@/server/execution/inventory-state";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import {
  databaseTime,
  executionEvent,
  executionHash,
  ownedLedgerAction,
  requireLease,
} from "@/server/execution/records";
import { previewFifoLots } from "@/server/positions/lots";
import { minimumUnits } from "@/shared/token-units";
import { verifiedWalletQuote, walletConversionRecord } from "./conversion";
import { synchronizePublicToken } from "./public-inventory";
import { verifiedWalletFunding } from "./source";

export async function executeWalletConversion(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (action.kind !== "defi" || action.status !== "reserved" || !plan.walletFundingId) {
    throw new ExecutionError("not_ready", "Only an unsent verified wallet funding transfer can be signed.");
  }
  await verifiedWalletFunding(db, userId, plan, actionId);
  const saved = await walletConversionRecord(db, action);
  await submitConfidentialTransfer(
    db,
    action,
    token,
    saved.order,
    (owner) => verifiedWalletQuote(action, saved, owner, Date.now()),
    (tx) => verifiedWalletFunding(tx, userId, plan, actionId).then(() => undefined),
    "wallet_conversion_submitted",
  );
}

export async function reconcileWalletConversion(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (!plan.walletFundingId) {
    throw new ExecutionError("conflict", "This is not a wallet funding transfer.");
  }
  const saved = await walletConversionRecord(db, action);
  const owner = z
    .object({ quoteRequest: z.object({ refundTo: z.string() }) })
    .parse(saved.order.providerQuote).quoteRequest.refundTo;
  async function refresh(): Promise<void> {
    await synchronizePublicToken(db, userId, owner, plan.cash[0]?.assetId ?? "");
    await synchronizePrivateInventory(db, userId);
  }
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await refresh();
    }
    return "settled";
  }
  requireLease(action, token, await databaseTime(db));
  if (!["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("not_ready", "Only a possibly submitted funding transfer can be reconciled.");
  }
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(saved.order.depositAddress));
  verifiedWalletQuote(
    action,
    {
      ...saved,
      order: {
        ...saved.order,
        providerQuote: confirmedStatusQuote(saved.order.providerQuote, status.quoteResponse),
      },
    },
    owner,
    saved.order.quotedAt,
  );
  z.object({ quote: z.object({ depositAddress: z.literal(saved.order.depositAddress) }) }).parse(
    status.quoteResponse,
  );
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    return "pending";
  }
  const source = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    destination = plan.cash.find((cash) => cash.scope === "confidential"),
    details = status.swapDetails,
    occurredAt = Date.parse(status.updatedAt);
  if (
    !source ||
    !destination ||
    occurredAt > Date.now() + 1000 ||
    details.amountIn === undefined ||
    details.amountOut === undefined ||
    details.refundedAmount === undefined ||
    details.depositedAmount !== source.maxDebitUnits ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(source.maxDebitUnits) ||
    details.intentHashes.length === 0 ||
    (BigInt(details.amountIn) === 0n) !== (BigInt(details.amountOut) === 0n) ||
    (status.status === "SUCCESS" && BigInt(details.amountOut) < BigInt(destination.minCreditUnits))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The funding result does not fully account for its input, private credit and refund.",
    );
  }
  const evidence = {
    status: status.status,
    debitUnits: details.amountIn,
    creditUnits: details.amountOut,
    refundedUnits: details.refundedAmount,
    intentHashes: details.intentHashes.toSorted(),
    occurredAt,
  };
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedLedgerAction(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    await executionEvent(tx, row, "wallet_conversion_terminal", now, evidence);
    if (evidence.debitUnits === "0") {
      if (evidence.status !== "REFUNDED" || evidence.refundedUnits !== source.maxDebitUnits) {
        throw new ExecutionError("conflict", "A zero-debit funding result must be fully refunded.");
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
        .where(eq(executionActions.id, row.id));
      await markInventoryUncertain(tx, row);
      return;
    }
    const debit = BigInt(evidence.debitUnits),
      credit = BigInt(evidence.creditUnits),
      lots = await previewFifoLots(tx, userId, row.agentId, "intents", source.assetId, debit);
    const carried = (lots.principalMicroUsd * minimumUnits(credit, debit)) / debit;
    // A same-token shield has no trading PnL or new historical basis. Carry only surviving principal.
    await settleDefiExecution(tx, userId, row.id, token, {
      providerEventId: `oneclick:${saved.order.depositAddress}`,
      riskDebitMicroUsd: (
        (row.notionalMicroUsd * debit + BigInt(source.maxDebitUnits) - 1n) /
        BigInt(source.maxDebitUnits)
      ).toString(),
      feeMicroUsd: null,
      ...(status.status === "REFUNDED" ? { fundingRefund: true } : {}),
      cash: [
        {
          scope: "intents",
          assetId: source.assetId,
          debitUnits: debit.toString(),
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
        {
          scope: "confidential",
          assetId: destination.assetId,
          debitUnits: "0",
          creditUnits: credit.toString(),
          creditValueMicroUsd:
            lots.basisMicroUsd === null ? null : ((lots.basisMicroUsd * credit) / debit).toString(),
          creditPrincipalMicroUsd: carried.toString(),
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: (lots.principalMicroUsd - carried).toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await refresh();
  return "settled";
}
