import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { previewFifoLots } from "@/server/positions/lots";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { settleDefiExecution } from "../defi-accounting";
import { defiPlanSchema } from "../defi-contracts";
import { intentsStatusSchema, readIntentsProviderStatus } from "../intents-reconciliation";
import { quoteMicroUsd } from "../oneclick-quote";
import { synchronizePrivateInventory } from "../private-inventory";
import { databaseTime, executionEvent, executionHash, ownedLedgerAction, requireLease } from "../records";
import { synchronizePerpsInventory } from "./account-state";
import { perpsCashAssetId } from "./contracts";
import { signedReturnRequest } from "./return-executor";
import { verifyReturnSource } from "./return-proof";
import { readReturnRecord, returnTransferTemplate, validateReturnPlan } from "./return-record";

async function refreshReturnBalances(db: AppDatabase, userId: string, agentId: string): Promise<void> {
  await Promise.all([
    synchronizePrivateInventory(db, userId),
    synchronizePerpsInventory(db, userId, agentId),
  ]);
}
export async function reconcilePerpsReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  lease: string,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (!plan.returnFunds) {
    throw new ExecutionError("conflict", "This action is not a Perps return.");
  }
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await refreshReturnBalances(db, userId, action.agentId);
    }
    return "settled";
  }
  requireLease(action, lease, await databaseTime(db));
  if (!["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("conflict", "Only an existing submitted return can be reconciled.");
  }
  const saved = await readReturnRecord(db, action),
    request = await signedReturnRequest(db, action);
  validateReturnPlan(plan, saved, saved.quotedAt);
  if (!request) {
    throw new ExecutionError("not_ready", "The signed return journal is unavailable.");
  }
  const { time, ...template } = request;
  if (executionHash(template) !== executionHash(returnTransferTemplate(saved)) || time < saved.quotedAt) {
    throw new ExecutionError("conflict", "The signed return differs from its preview.");
  }
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(saved.depositAddress));
  validateReturnPlan(plan, { ...saved, providerQuote: status.quoteResponse }, saved.quotedAt);
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    return "pending";
  }
  const details = status.swapDetails,
    occurredAt = Date.parse(status.updatedAt);
  if (
    occurredAt < time ||
    occurredAt > Date.now() + 1000 ||
    details.amountIn === undefined ||
    details.amountOut === undefined ||
    details.refundedAmount === undefined ||
    details.depositedAmount !== saved.bridgeUnits ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(saved.bridgeUnits) ||
    (BigInt(details.amountIn) === 0n) !== (BigInt(details.amountOut) === 0n) ||
    (status.status === "SUCCESS" && (details.refundedAmount !== "0" || details.amountIn === "0")) ||
    (status.status === "REFUNDED" && details.refundedAmount === "0") ||
    !details.originChainTxHashes?.length ||
    (details.amountOut !== "0" && details.intentHashes.length === 0)
  ) {
    throw new ExecutionError(
      "not_ready",
      "The route has not accounted for the complete return, fee and refund.",
    );
  }
  const refund = BigInt(details.refundedAmount);
  await verifyReturnSource(
    saved,
    request,
    details.originChainTxHashes.map((item) => item.hash),
    refund,
  );
  const debit = BigInt(saved.debitUnits) - refund / 100n,
    credit = BigInt(details.amountOut),
    creditValue = credit === 0n ? 0n : quoteMicroUsd(details.amountOutUsd ?? "", false);
  await userTransaction(db, userId, async (tx) => {
    const current = await ownedLedgerAction(tx, userId, actionId);
    requireLease(current, lease, await databaseTime(tx));
    const lots = await previewFifoLots(
        tx,
        userId,
        action.agentId,
        "hyperliquid",
        perpsCashAssetId(saved.address),
        debit,
      ),
      principal = minimumUnits(lots.principalMicroUsd, creditValue);
    await executionEvent(tx, current, "perps_return_terminal", await databaseTime(tx), {
      depositAddress: saved.depositAddress,
      amountIn: details.amountIn,
      amountOut: details.amountOut,
      refundedAmount: details.refundedAmount,
      originHashes: details.originChainTxHashes,
      intentHashes: details.intentHashes,
      status: status.status,
    });
    await settleDefiExecution(tx, userId, actionId, lease, {
      ...(refund > 0n ? { fundingRefund: true } : {}),
      providerEventId: `oneclick:${saved.depositAddress}`,
      riskDebitMicroUsd: debit.toString(),
      feeMicroUsd: null,
      cash: [
        {
          assetId: perpsCashAssetId(saved.address),
          debitUnits: debit.toString(),
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
        {
          assetId: saved.output.assetId,
          debitUnits: "0",
          creditUnits: credit.toString(),
          creditValueMicroUsd: creditValue.toString(),
          creditPrincipalMicroUsd: principal.toString(),
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: (lots.principalMicroUsd - principal).toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await refreshReturnBalances(db, userId, action.agentId);
  return "settled";
}
