import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError, executionPlanSchema } from "@/server/execution/contracts";
import { prepareIntentsOrder } from "@/server/execution/intents-quote";
import { preparedOrderSchema } from "@/server/execution/intents-record";
import { executionHash } from "@/server/execution/records";
import { tokenUnits } from "@/server/research/decimal";
import { intentTokens } from "@/server/research/intents";
import { type ManualSpotIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { type TradeAsset, tradeAssetSchema } from "@/shared/trade-preview";
import type { ManualEnvelope } from "./record";

export async function manualSpotAssets(
  intent: ManualSpotIntent,
): Promise<{ input: TradeAsset; output: TradeAsset }> {
  const { tokens } = await intentTokens();
  const selected = [intent.inputAssetId, intent.outputAssetId].map((id) => {
    const matches = tokens.filter((t) => t.assetId === id);
    if (matches.length !== 1 || !matches[0]) {
      throw new ExecutionError("not_ready", "Choose an exact supported token contract.");
    }
    const t = matches[0];
    return tradeAssetSchema.parse({
      symbol: t.symbol,
      tokenSymbol: t.symbol,
      assetId: t.assetId,
      blockchain: t.blockchain,
      contractAddress: t.contractAddress ?? null,
      decimals: t.decimals,
    });
  });
  const [input, output] = selected;
  if (!input || !output) {
    throw new ExecutionError("not_ready", "Choose both trade tokens.");
  }
  return { input, output };
}
export async function prepareManualSpot(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualSpotIntent,
): Promise<ManualEnvelope> {
  const { input, output } = await manualSpotAssets(intent);
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const session = await privateBalanceToken(db, userId);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect your private balance in Trading access first.");
  }
  const units = tokenUnits(intent.amount, input.decimals).toString();
  const order = await prepareIntentsOrder(
    {
      accountId: owner.accountId,
      inputAssetId: input.assetId,
      outputAssetId: output.assetId,
      inputUnits: units,
      slippageBps: intent.slippageBps,
      maximumProviderFeeBps: intent.maximumFeeBps,
    },
    undefined,
    session,
  );
  if (order.quote.inputMicroUsd === null) {
    throw new ExecutionError("not_ready", "The route could not verify the input value. Choose another pair.");
  }
  const quote = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  const plan = executionPlanSchema.parse({
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "manual",
    manualTradeId: id,
    scope: "confidential",
    inputAssetId: input.assetId,
    outputAssetId: output.assetId,
    inputUnits: units,
    minOutputUnits: order.quote.minOutputUnits,
    notionalMicroUsd: order.quote.inputMicroUsd,
    slippageBps: intent.slippageBps,
    providerFeeBps: order.quote.appFeeBps,
    quoteId: order.depositAddress,
    quoteHash: order.quote.quoteHash,
    expiresAt: order.quote.expiresAt,
  });
  const prepared = preparedOrderSchema.parse({
    format: 1,
    signalHash: executionHash(intent),
    quotedAt: order.quote.capturedAt,
    maximumProviderFeeBps: intent.maximumFeeBps,
    requestDeadline: quote.quoteRequest.deadline,
    providerDeadline: quote.quote.deadline,
    providerQuote: order.providerQuote,
    generated: order.generated,
    payloadHash: order.payloadHash,
    depositAddress: order.depositAddress,
  });
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: `Swap ${intent.amount} ${input.tokenSymbol} → ${output.tokenSymbol}`,
    venue: "NEAR Intents",
    input,
    output,
    inputUnits: units,
    outputUnits: order.quote.outputUnits,
    minimumOutputUnits: order.quote.minOutputUnits,
    maximumDebit: `${intent.amount} ${input.tokenSymbol}`,
    limitPrice: null,
    feeNote: order.quote.feeNote,
    visibility: "confidential",
    expiresAt: plan.expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "intents", preview, plan, prepared };
}
