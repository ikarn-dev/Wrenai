import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { registryTradeAsset } from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { HYPERLIQUID_BRIDGE_USDC, perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { requireClosedReturnVenue } from "@/server/execution/hyperliquid/return-source";
import { prepareIntentsOrder } from "@/server/execution/intents-quote";
import { preparedOrderSchema } from "@/server/execution/intents-record";
import { verifiedFundingQuote } from "@/server/execution/perps-funding-order";
import { fundingRecordSchema } from "@/server/execution/perps-funding-record";
import { executionHash } from "@/server/execution/records";
import { tokenUnits } from "@/server/research/decimal";
import { intentTokens } from "@/server/research/intents";
import { ensureManualTradingAccount } from "@/server/trading-accounts/agent-account";
import { type ManualFundingIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { formatUnits } from "@/shared/money";
import type { TradeAsset } from "@/shared/trade-preview";
import type { ManualEnvelope } from "./record";
import { manualReturnSource } from "./return-source";

export async function prepareManualPerpsDeposit(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualFundingIntent,
): Promise<ManualEnvelope> {
  const account = await ensureManualTradingAccount(db, userId, subjectId),
    tokens = (await intentTokens()).tokens;
  await watchPerpsPosition(db, userId, subjectId, false);
  await manualReturnSource(db, userId, subjectId);
  await requireClosedReturnVenue(db, userId, subjectId);
  const token = tokens.find((t) => t.assetId === intent.assetId);
  const [owner] = await db.select().from(users).where(eq(users.id, userId)).limit(1),
    session = await privateBalanceToken(db, userId);
  if (!token || !owner || !session) {
    throw new ExecutionError("not_ready", "Choose a supported private token and connect its balance.");
  }
  const input = registryTradeAsset(token),
    units = tokenUnits(intent.amount, input.decimals).toString();
  const order = await prepareIntentsOrder(
    {
      accountId: owner.accountId,
      inputAssetId: input.assetId,
      outputAssetId: HYPERLIQUID_BRIDGE_USDC,
      inputUnits: units,
      perpsRecipient: account.perpAddress,
      slippageBps: intent.slippageBps,
      maximumProviderFeeBps: intent.maximumFeeBps,
    },
    undefined,
    session,
  );
  const dates = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  const minimum = BigInt(order.quote.minOutputUnits) / 100n;
  if (minimum <= 0n) {
    throw new ExecutionError("limit", "The route amount is below the venue's minimum credit.");
  }
  const prepared = fundingRecordSchema.parse({
    format: 1,
    recipient: account.perpAddress,
    order: preparedOrderSchema.parse({
      format: 1,
      signalHash: executionHash(intent),
      quotedAt: order.quote.capturedAt,
      maximumProviderFeeBps: intent.maximumFeeBps,
      requestDeadline: dates.quoteRequest.deadline,
      providerDeadline: dates.quote.deadline,
      providerQuote: order.providerQuote,
      generated: order.generated,
      payloadHash: order.payloadHash,
      depositAddress: order.depositAddress,
    }),
  });
  const output: TradeAsset = {
    symbol: "USDC",
    tokenSymbol: "USDC",
    assetId: perpsCashAssetId(account.perpAddress),
    blockchain: "hyperliquid",
    decimals: 6,
    contractAddress: null,
  };
  const plan = defiPlanSchema.parse({
    format: 2,
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "manual",
    manualTradeId: id,
    funding: true,
    scope: "confidential",
    operation: "transfer",
    venueId: "confidential-intents",
    permissionHash: executionHash({ id, intent }),
    cash: [
      { assetId: input.assetId, maxDebitUnits: units, minCreditUnits: "0" },
      {
        scope: "hyperliquid",
        assetId: output.assetId,
        maxDebitUnits: "0",
        minCreditUnits: minimum.toString(),
      },
    ],
    positions: [],
    notionalMicroUsd: order.quote.inputMicroUsd,
    slippageBps: intent.slippageBps,
    providerFeeBps: order.quote.appFeeBps,
    quoteId: order.depositAddress,
    quoteHash: order.quote.quoteHash,
    payloadHash: order.payloadHash,
    recipient: account.perpAddress,
    expiresAt: order.quote.expiresAt,
  });
  verifiedFundingQuote(
    { planJson: JSON.stringify(plan), notionalMicroUsd: BigInt(plan.notionalMicroUsd) },
    prepared,
    owner.accountId,
    Date.now(),
  );
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: "Add funds to manual Perps",
    venue: "NEAR Intents",
    input,
    output,
    inputUnits: units,
    outputUnits: (BigInt(order.quote.outputUnits) / 100n).toString(),
    minimumOutputUnits: minimum.toString(),
    maximumDebit: `${intent.amount} ${input.tokenSymbol}`,
    limitPrice: null,
    feeNote: `Receive at least ${formatUnits(minimum, { decimals: 6, fractionDigits: 6 })} USDC at your separate trading address. ${order.quote.feeNote}`,
    visibility: "public",
    expiresAt: plan.expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "perps_funding", preview, plan, prepared };
}
