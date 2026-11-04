import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { registryTradeAsset } from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { hlAddressSchema, perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import {
  returnQuoteRequest,
  returnRecordSchema,
  returnTransferTemplate,
  verifiedReturnQuote,
} from "@/server/execution/hyperliquid/return-record";
import { requireClosedReturnVenue } from "@/server/execution/hyperliquid/return-source";
import { oneClickJson } from "@/server/execution/oneclick-quote";
import { executionHash } from "@/server/execution/records";
import { tokenUnits } from "@/server/research/decimal";
import { intentTokens } from "@/server/research/intents";
import { type ManualFundingIntent, manualPreviewSchema } from "@/shared/manual-trading";
import type { TradeAsset } from "@/shared/trade-preview";
import type { ManualEnvelope } from "./record";
import { manualReturnSource } from "./return-source";

export async function prepareManualPerpsReturn(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualFundingIntent,
): Promise<ManualEnvelope> {
  const { account } = await manualReturnSource(db, userId, subjectId),
    venue = await requireClosedReturnVenue(db, userId, subjectId);
  const token = (await intentTokens()).tokens.find((t) => t.assetId === intent.assetId),
    session = await privateBalanceToken(db, userId);
  const [owner] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!token || !session || !owner) {
    throw new ExecutionError("not_ready", "Choose an exact return token and connect your private balance.");
  }
  const output = registryTradeAsset(token),
    debit = tokenUnits(intent.amount, 6),
    before = hlUnits(venue.crossMarginSummary.totalRawUsd, 6, "down");
  if (debit < 1_500_000n || debit > before || debit > hlUnits(venue.withdrawable, 6, "down")) {
    throw new ExecutionError("limit", "Return at least 1.5 USDC, within the confirmed withdrawable balance.");
  }
  const request = {
    bridgeUnits: ((debit - 1_000_000n) * 100n).toString(),
    output,
    address: account.perpAddress,
    ownerAccountId: owner.accountId,
    requestDeadline: new Date(Date.now() + 120_000).toISOString(),
    slippageBps: intent.slippageBps,
  };
  const providerQuote = await oneClickJson("/v0/quote", returnQuoteRequest(request), undefined, session);
  const wire = z
      .object({
        timestamp: z.iso.datetime(),
        quote: z.object({ depositAddress: hlAddressSchema, deadline: z.iso.datetime() }),
      })
      .parse(providerQuote),
    now = Date.now();
  const prepared = returnRecordSchema.parse({
    format: "perps-return-v1",
    ...request,
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    rootId: account.rootId,
    debitUnits: debit.toString(),
    beforeCashUnits: before.toString(),
    quotedAt: now,
    expiresAt: Math.min(now + 15_000, Date.parse(wire.timestamp) + 15_000),
    maximumProviderFeeBps: intent.maximumFeeBps,
    depositAddress: wire.quote.depositAddress,
    providerDeadline: wire.quote.deadline,
    providerQuote,
  });
  const q = verifiedReturnQuote(prepared, now),
    source = perpsCashAssetId(account.perpAddress);
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
    returnFunds: true,
    fundingFeeUnits: "1000000",
    scope: "hyperliquid",
    operation: "transfer",
    venueId: "hyperliquid",
    permissionHash: executionHash({ id, intent }),
    cash: [
      { assetId: source, maxDebitUnits: debit.toString(), minCreditUnits: "0" },
      {
        assetId: output.assetId,
        scope: "confidential",
        maxDebitUnits: "0",
        minCreditUnits: q.minOutputUnits,
      },
    ],
    positions: [],
    notionalMicroUsd: debit.toString(),
    slippageBps: intent.slippageBps,
    providerFeeBps: q.appFeeBps,
    quoteId: prepared.depositAddress,
    quoteHash: q.quoteHash,
    payloadHash: executionHash(returnTransferTemplate(prepared)),
    recipient: owner.accountId,
    expiresAt: prepared.expiresAt,
  });
  const input: TradeAsset = {
    symbol: "USDC",
    tokenSymbol: "USDC",
    assetId: source,
    blockchain: "hyperliquid",
    decimals: 6,
    contractAddress: null,
  };
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: "Return manual Perps funds",
    venue: "NEAR Intents",
    input,
    output,
    inputUnits: debit.toString(),
    outputUnits: q.outputUnits,
    minimumOutputUnits: q.minOutputUnits,
    maximumDebit: `${intent.amount} USDC`,
    limitPrice: null,
    feeNote: `Includes the 1 USDC venue transfer fee. ${q.feeNote}`,
    visibility: "public",
    expiresAt: plan.expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "perps_return", preview, plan, prepared };
}
