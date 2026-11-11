import "server-only";
import { eq } from "drizzle-orm";
import { assertWalletPayoutToken, walletPayoutTokens } from "@/server/claims/payout-token";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema, WALLET_RETURN_VENUES } from "@/server/execution/defi-contracts";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash } from "@/server/execution/records";
import { quoteWalletReturn } from "@/server/execution/wallet-return";
import { tokenUnits } from "@/server/research/decimal";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { type ManualWalletReturnIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { type TradeAsset, tradeAssetSchema } from "@/shared/trade-preview";
import { manualAvailableUnits } from "./balances";
import type { ManualEnvelope } from "./record";

function asset(token: IntentToken): TradeAsset {
  return tradeAssetSchema.parse({
    symbol: token.symbol,
    tokenSymbol: token.symbol,
    assetId: token.assetId,
    blockchain: token.blockchain,
    contractAddress: token.contractAddress ?? null,
    decimals: token.decimals,
  });
}

/**
 * Quotes a claim of private-balance funds that no agent holds, paid to the owner's own NEAR wallet as held or in
 * the NEAR token they chose. The owner's confirmation of this exact card is the only authority; nothing is
 * reserved until then.
 */
export async function prepareManualWalletReturn(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualWalletReturnIntent,
): Promise<ManualEnvelope> {
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const session = await privateBalanceToken(db, userId);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect your private balance in Trading access first.");
  }
  const receiveAssetId = intent.receiveAssetId ?? intent.assetId;
  const [held, received] = await Promise.all([
    intentTokens().then(({ tokens }) => walletPayoutTokens(tokens).find((t) => t.assetId === intent.assetId)),
    assertWalletPayoutToken(owner.accountId, receiveAssetId),
  ]);
  if (!held) {
    throw new ExecutionError("not_ready", "Only NEAR tokens can be paid to your NEAR wallet.");
  }
  const input = asset(held),
    output = asset(received);
  await synchronizePrivateInventory(db, userId);
  const units = tokenUnits(intent.amount, input.decimals);
  const free = await manualAvailableUnits(
    db,
    userId,
    subjectId,
    "confidential",
    input.assetId,
    await databaseTime(db),
  );
  if (units > free) {
    throw new ExecutionError(
      "insufficient_funds",
      "That's more than your free private balance. Funds an agent holds return when you claim that agent.",
    );
  }
  const { quote, saved, expiresAt } = await quoteWalletReturn({
    accountId: owner.accountId,
    scope: "confidential",
    assetId: input.assetId,
    payoutAssetId: output.assetId,
    units,
    slippageBps: intent.slippageBps,
    maximumProviderFeeBps: intent.maximumFeeBps,
    requestId: id,
    session,
  });
  const swapped = output.assetId !== input.assetId;
  const notional = BigInt(quote.inputMicroUsd ?? "0");
  const plan = defiPlanSchema.parse({
    format: 2,
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "manual",
    manualTradeId: id,
    walletReturn: true,
    ...(swapped ? { payoutAssetId: output.assetId } : {}),
    scope: "confidential",
    operation: "transfer",
    venueId: WALLET_RETURN_VENUES.confidential,
    permissionHash: executionHash({ id, intent }),
    cash: [{ assetId: input.assetId, maxDebitUnits: quote.inputUnits, minCreditUnits: "0" }],
    positions: [],
    // A positive bound for the ledger; claiming your own funds is not spending.
    notionalMicroUsd: (notional > 0n ? notional : 1n).toString(),
    slippageBps: intent.slippageBps,
    providerFeeBps: quote.appFeeBps,
    quoteId: saved.order.depositAddress,
    quoteHash: quote.quoteHash,
    payloadHash: saved.order.payloadHash,
    recipient: owner.accountId,
    expiresAt,
  });
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: swapped
      ? `Claim ${intent.amount} ${input.tokenSymbol} as ${output.tokenSymbol}`
      : `Claim ${intent.amount} ${input.tokenSymbol}`,
    venue: "NEAR Intents",
    input,
    output,
    inputUnits: quote.inputUnits,
    outputUnits: quote.outputUnits,
    minimumOutputUnits: quote.minOutputUnits,
    maximumDebit: `${intent.amount} ${input.tokenSymbol}`,
    limitPrice: null,
    feeNote: `Paid to ${owner.accountId}. The transfer to your wallet is public on NEAR. ${quote.feeNote}`,
    visibility: "public",
    expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "wallet_return", preview, plan, prepared: saved };
}
