import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { registryTradeAsset } from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { prepareIntentsOrder } from "@/server/execution/intents-quote";
import { paymentRecordSchema } from "@/server/execution/payment-order";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash } from "@/server/execution/records";
import { intentTokens } from "@/server/research/intents";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { type ManualPaymentIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { parseTokenAmount } from "@/shared/token-units";
import type { TradeAsset } from "@/shared/trade-preview";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";
import { manualAvailableUnits } from "./balances";
import type { ManualEnvelope } from "./record";

export class PaymentShortfall extends ExecutionError {
  constructor(
    readonly accountId: string,
    readonly asset: TradeAsset,
    readonly required: bigint,
    readonly missing: bigint,
  ) {
    super(
      "insufficient_funds",
      `Your unallocated private balance cannot cover this ${asset.tokenSymbol} payment.`,
    );
  }
}

export async function prepareManualPayment(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualPaymentIntent,
  maximumDebitUnits?: string,
): Promise<ManualEnvelope> {
  const [[owner], session, registry] = await Promise.all([
    db.select({ accountId: users.accountId }).from(users).where(eq(users.id, userId)).limit(1),
    privateBalanceToken(db, userId),
    intentTokens(),
  ]);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect your private balance before sending.");
  }
  const token = registry.tokens.find(
    (item) => item.assetId === intent.assetId && item.blockchain.toLowerCase() === "near",
  );
  if (!token) {
    throw new ExecutionError("not_ready", "This token is unavailable for private payments.");
  }
  if (owner.accountId === intent.recipient) {
    throw new ExecutionError("conflict", "Choose another recipient for a private payment.");
  }
  const asset = registryTradeAsset(token);
  const symbol = token.assetId === WALLET_SWAP_INPUT ? "wNEAR" : token.symbol;
  let amountUnits: string;
  try {
    amountUnits = parseTokenAmount(intent.amount, asset.decimals).toString();
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError)) {
      throw error;
    }
    throw new ExecutionError("limit", "Enter an amount within the token's supported precision.");
  }
  const [order] = await Promise.all([
    prepareIntentsOrder(
      {
        accountId: owner.accountId,
        inputAssetId: token.assetId,
        outputAssetId: token.assetId,
        inputUnits: amountUnits,
        paymentRecipient: intent.recipient,
        paymentDestination: "confidential",
        slippageBps: intent.slippageBps,
        maximumProviderFeeBps: intent.maximumFeeBps,
      },
      undefined,
      session,
    ),
    synchronizePrivateInventory(db, userId),
  ]);
  const { quote } = order;
  const debit = BigInt(quote.inputUnits);
  if (maximumDebitUnits !== undefined && debit > BigInt(maximumDebitUnits)) {
    throw new ExecutionError("limit", "The payment now costs more than the reviewed maximum.");
  }
  const amount = BigInt(amountUnits);
  if (
    quote.minOutputUnits !== amountUnits ||
    debit < amount ||
    (debit - amount) * 10_000n > amount * BigInt(intent.slippageBps + intent.maximumFeeBps)
  ) {
    throw new ExecutionError(
      "limit",
      "The private route could not quote the exact payment within its fee limit.",
    );
  }
  const available = await manualAvailableUnits(
    db,
    userId,
    subjectId,
    "confidential",
    token.assetId,
    await databaseTime(db),
  );
  const displayedAsset = { ...asset, tokenSymbol: symbol };
  if (debit > available) {
    throw new PaymentShortfall(owner.accountId, displayedAsset, debit, debit - available);
  }
  const provider = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  const prepared = paymentRecordSchema.parse({
    format: 1,
    amountUnits,
    recipient: intent.recipient,
    destination: "confidential",
    order: {
      format: 1,
      signalHash: executionHash({ id, intent }),
      quotedAt: quote.capturedAt,
      maximumProviderFeeBps: intent.maximumFeeBps,
      requestDeadline: provider.quoteRequest.deadline,
      providerDeadline: provider.quote.deadline,
      providerQuote: order.providerQuote,
      generated: order.generated,
      payloadHash: order.payloadHash,
      depositAddress: order.depositAddress,
    },
  });
  const plan = defiPlanSchema.parse({
    format: 2,
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "manual",
    manualTradeId: id,
    scope: "confidential",
    operation: "transfer",
    venueId: "confidential-intents",
    permissionHash: executionHash({ id, intent }),
    cash: [{ assetId: token.assetId, maxDebitUnits: quote.inputUnits, minCreditUnits: "0" }],
    positions: [],
    notionalMicroUsd: quote.inputMicroUsd,
    slippageBps: intent.slippageBps,
    providerFeeBps: quote.appFeeBps,
    quoteId: order.depositAddress,
    quoteHash: quote.quoteHash,
    payloadHash: order.payloadHash,
    recipient: intent.recipient,
    expiresAt: quote.expiresAt,
  });
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: "Private payment",
    venue: "NEAR Intents",
    input: displayedAsset,
    output: displayedAsset,
    inputUnits: quote.inputUnits,
    outputUnits: amountUnits,
    minimumOutputUnits: amountUnits,
    maximumDebit: `${budgetTokenAmount(quote.inputUnits, asset.decimals)} ${symbol}`,
    limitPrice: null,
    feeNote: quote.feeNote,
    visibility: "confidential",
    expiresAt: quote.expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "payment", preview, plan, prepared };
}
