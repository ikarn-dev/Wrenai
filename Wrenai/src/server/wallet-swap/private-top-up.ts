import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readWalletAllocations } from "@/server/agents/token-budgets";
import type { AppDatabase } from "@/server/db/client";
import { manualTrades } from "@/server/db/manual-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { confirmedStatusQuote, type intentsStatusSchema } from "@/server/execution/intents-reconciliation";
import { oneClickJson, providerSlippageBps, verifiedProviderQuote } from "@/server/execution/oneclick-quote";
import { databaseTime, executionHash } from "@/server/execution/records";
import type { PaymentShortfall } from "@/server/manual-trading/payment";
import { callViewFunction } from "@/server/near/rpc";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { budgetTokenAmount, nearAccountSchema } from "@/shared/agent-budget";
import type { ManualPaymentIntent } from "@/shared/manual-trading";
import { tokenUnitsSchema } from "@/shared/token-units";
import {
  type PaymentTopUpView,
  WALLET_SWAP_NATIVE_OUTPUT,
  type WalletSwapQuote,
  type WalletSwapView,
  walletSwapQuoteSchema,
} from "@/shared/wallet-swap";

const DEPOSIT_WINDOW_MS = 30 * 60_000;
const SIGNING_MARGIN_MS = 60_000;
const GAS_RESERVE = 10_000_000_000_000_000_000_000n;
type TopUp = NonNullable<WalletSwapQuote["privateTopUp"]>;
type TopUpQuote = WalletSwapQuote & { privateTopUp: TopUp };

export function paymentTopUpView(deposit: WalletSwapView): PaymentTopUpView {
  const { privateTopUp, ...quote } = deposit.quote;
  if (!privateTopUp) {
    throw new ExecutionError("conflict", "This is not a private payment deposit.");
  }
  return {
    ...deposit,
    quote,
    maximumDebitUnits: privateTopUp.maximumDebitUnits,
    reviewRequired: Boolean(privateTopUp.reviewRequired),
  };
}

function providerRequest(
  accountId: string,
  intent: ManualPaymentIntent,
  units: string,
  deadline: string,
): QuoteRequest {
  return {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_OUTPUT,
    slippageTolerance: providerSlippageBps(intent.slippageBps),
    originAsset: intent.assetId,
    destinationAsset: intent.assetId,
    amount: units,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: accountId,
    refundTo: accountId,
    deadline,
    quoteWaitingTimeMs: 0,
    appFees: [],
  };
}

export async function readPaymentTopUp(
  db: AppDatabase,
  owner: string,
  id: string,
): Promise<(WalletSwapView & { quote: TopUpQuote }) | null> {
  const [row] = await db
    .select()
    .from(walletSwaps)
    .where(
      and(
        eq(walletSwaps.userId, owner),
        eq(walletSwaps.id, id),
        sql`${walletSwaps.quoteJson}::jsonb ? 'privateTopUp'`,
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const quote = walletSwapQuoteSchema.parse(JSON.parse(row.quoteJson));
  if (
    !quote.privateTopUp ||
    quote.request.requestId !== id ||
    quote.accountId !== row.accountId ||
    quote.depositAddress !== row.depositAddress
  ) {
    throw new ExecutionError("conflict", "The wallet deposit differs from the reviewed payment.");
  }
  return {
    id,
    quote: { ...quote, privateTopUp: quote.privateTopUp },
    state: row.state === "quoted" && row.expiresAt <= Date.now() ? "expired" : row.state,
    transactionHash: row.transactionHash,
    expiresAt: row.expiresAt,
    receivedUnits: row.receivedUnits,
    spentUnits: row.spentUnits,
  };
}

export async function preparePaymentTopUp(
  db: AppDatabase,
  owner: string,
  id: string,
  intent: ManualPaymentIntent,
  shortfall: PaymentShortfall,
  signingPublicKey: string,
): Promise<WalletSwapView> {
  const account = shortfall.accountId;
  const amount = shortfall.missing.toString();
  const request = providerRequest(
    account,
    intent,
    amount,
    new Date(Date.now() + DEPOSIT_WINDOW_MS).toISOString(),
  );
  const [raw, wallet, near, reserved, storage] = await Promise.all([
    oneClickJson("/v0/quote", request),
    walletTokenHolding(account, intent.assetId),
    walletTokenHolding(account, WALLET_SWAP_NATIVE_OUTPUT),
    readWalletAllocations(db, owner, account),
    callViewFunction(intent.assetId.slice(7), "storage_balance_bounds", {}).then(
      ({ value }) => z.object({ min: tokenUnitsSchema }).parse(value).min,
    ),
  ]);
  const quote = verifiedProviderQuote(raw, request, "intents", Date.now(), intent.slippageBps);
  const units = BigInt(quote.inputUnits);
  if (
    quote.minOutputUnits !== amount ||
    units < shortfall.missing ||
    quote.appFeeBps > intent.maximumFeeBps ||
    (units - shortfall.missing) * 10_000n >
      shortfall.missing * BigInt(intent.slippageBps + intent.maximumFeeBps) + 10_000n
  ) {
    throw new ExecutionError("limit", "The wallet top-up exceeds the payment's fee or slippage limits.");
  }
  if (
    wallet.decimals !== shortfall.asset.decimals ||
    BigInt(wallet.spendableUnits) - reserved(intent.assetId) < units
  ) {
    throw new ExecutionError(
      "insufficient_funds",
      `Your wallet cannot cover the ${shortfall.asset.tokenSymbol} top-up.`,
    );
  }
  if (
    BigInt(storage) > GAS_RESERVE ||
    BigInt(near.spendableUnits) - reserved(WALLET_SWAP_NATIVE_OUTPUT) < GAS_RESERVE + BigInt(storage) + 1n
  ) {
    throw new ExecutionError(
      "insufficient_funds",
      "Your wallet needs more NEAR for top-up gas and registration.",
    );
  }
  const signed = z
    .object({
      timestamp: z.iso.datetime(),
      quote: z.object({
        depositAddress: nearAccountSchema,
        deadline: z.iso.datetime(),
        depositMemo: z.union([z.literal(""), z.null()]).optional(),
      }),
    })
    .parse(raw);
  const saved = walletSwapQuoteSchema.parse({
    request: {
      requestId: id,
      inputAssetId: intent.assetId,
      outputAssetId: intent.assetId,
      amount: budgetTokenAmount(quote.inputUnits, shortfall.asset.decimals),
      slippageBps: intent.slippageBps,
      maximumFeeBps: intent.maximumFeeBps,
    },
    accountId: account,
    depositAddress: signed.quote.depositAddress,
    depositKind: "nep141",
    pairVerified: true,
    storageDepositUnits: storage,
    input: shortfall.asset,
    output: shortfall.asset,
    inputUnits: quote.inputUnits,
    outputUnits: quote.outputUnits,
    minimumOutputUnits: quote.minOutputUnits,
    appFeeBps: quote.appFeeBps,
    quoteHash: quote.quoteHash,
    privateTopUp: {
      intent,
      maximumDebitUnits: shortfall.required.toString(),
      signingPublicKey,
      requestDeadline: request.deadline,
      providerQuoteJson: JSON.stringify(raw),
      quotedAt: signed.timestamp,
    },
  });
  await userTransaction(db, owner, async (tx) => {
    const [manual] = await tx
      .select({ id: manualTrades.id })
      .from(manualTrades)
      .where(and(eq(manualTrades.userId, owner), eq(manualTrades.id, id)))
      .limit(1);
    if (manual) {
      throw new ExecutionError("conflict", "This payment already has a private review.");
    }
    const now = await databaseTime(tx);
    const expiresAt =
      Math.min(Date.parse(request.deadline), Date.parse(signed.quote.deadline)) - SIGNING_MARGIN_MS;
    if (expiresAt <= now) {
      throw new ExecutionError("not_ready", "The top-up quote expires too soon. Review the payment again.");
    }
    await tx
      .insert(walletSwaps)
      .values({
        id,
        userId: owner,
        accountId: account,
        quoteJson: JSON.stringify(saved),
        depositAddress: saved.depositAddress,
        state: "quoted",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });
  const view = await readPaymentTopUp(db, owner, id);
  if (!view || executionHash(view.quote.privateTopUp.intent) !== executionHash(intent)) {
    throw new ExecutionError("conflict", "This request already belongs to another payment.");
  }
  return view;
}

export function verifyPaymentTopUpStatus(
  quote: WalletSwapQuote,
  status: z.infer<typeof intentsStatusSchema>,
  hash: string,
): void {
  const topUp = quote.privateTopUp;
  if (!topUp || (status.status !== "SUCCESS" && status.status !== "REFUNDED")) {
    return;
  }
  const stored: unknown = JSON.parse(topUp.providerQuoteJson);
  const raw = confirmedStatusQuote(stored, status.quoteResponse);
  const signed = verifiedProviderQuote(
    raw,
    providerRequest(quote.accountId, topUp.intent, quote.outputUnits, topUp.requestDeadline),
    "intents",
    Date.parse(topUp.quotedAt),
    topUp.intent.slippageBps,
  );
  const details = status.swapDetails;
  const success = status.status === "SUCCESS";
  if (
    signed.quoteHash !== quote.quoteHash ||
    signed.inputUnits !== quote.inputUnits ||
    signed.minOutputUnits !== quote.minimumOutputUnits ||
    signed.appFeeBps > topUp.intent.maximumFeeBps ||
    details.originChainTxHashes?.length !== 1 ||
    details.originChainTxHashes[0]?.hash !== hash ||
    details.depositedAmount !== quote.inputUnits ||
    details.amountIn === undefined ||
    details.refundedAmount === undefined ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(quote.inputUnits) ||
    (success
      ? details.amountOut !== quote.outputUnits || details.amountIn === "0"
      : details.amountIn !== "0" || (details.amountOut ?? "0") !== "0")
  ) {
    throw new ExecutionError(
      "not_ready",
      "The provider hasn't verified the exact private-balance credit or refund yet.",
    );
  }
}

export async function requireReviewAfterTopUp(db: AppDatabase, owner: string, id: string): Promise<void> {
  await userTransaction(db, owner, async (tx) => {
    const [confirmed] = await tx
      .select({ id: manualTrades.id })
      .from(manualTrades)
      .where(
        and(eq(manualTrades.userId, owner), eq(manualTrades.id, id), eq(manualTrades.status, "confirmed")),
      )
      .limit(1);
    if (confirmed) {
      return;
    }
    await tx
      .update(walletSwaps)
      .set({
        quoteJson: sql`jsonb_set(${walletSwaps.quoteJson}::jsonb, '{privateTopUp,reviewRequired}', 'true')::text`,
      })
      .where(and(eq(walletSwaps.id, id), eq(walletSwaps.userId, owner), eq(walletSwaps.state, "settled")));
  });
}
