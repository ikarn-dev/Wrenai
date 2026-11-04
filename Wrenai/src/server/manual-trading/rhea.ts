import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { executionPlanSchema } from "@/server/execution/contracts";
import { MAX_NATIVE_GAS_UNITS } from "@/server/execution/rhea/contracts";
import { nativeTokenAsset } from "@/server/execution/rhea/inventory";
import { prepareRheaOrder } from "@/server/execution/rhea/order";
import { readDclPairPool } from "@/server/execution/rhea/quote";
import { tokenUnits } from "@/server/research/decimal";
import { type ManualSpotIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { formatUnits } from "@/shared/money";
import type { ManualEnvelope } from "./record";

export async function prepareManualRhea(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualSpotIntent,
): Promise<ManualEnvelope> {
  const [input, output, poolId] = await Promise.all([
    nativeTokenAsset(intent.inputAssetId),
    nativeTokenAsset(intent.outputAssetId),
    readDclPairPool(intent.inputAssetId, intent.outputAssetId),
  ]);
  const units = tokenUnits(intent.amount, input.decimals).toString();
  const prepared = await prepareRheaOrder(db, userId, input, output, units, intent.slippageBps, poolId),
    q = prepared.quote;
  const plan = executionPlanSchema.parse({
    requestId: id,
    agentId: subjectId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 0,
    budgetMode: "manual",
    manualTradeId: id,
    scope: "native_near",
    inputAssetId: input.assetId,
    outputAssetId: output.assetId,
    inputUnits: units,
    minOutputUnits: q.minimumOutputUnits,
    notionalMicroUsd: q.inputMicroUsd,
    slippageBps: intent.slippageBps,
    providerFeeBps: 0,
    quoteId: poolId,
    quoteHash: prepared.quoteHash,
    expiresAt: q.expiresAt,
  });
  const preview = manualPreviewSchema.parse({
    id,
    revision: 1,
    bindingHash: "0".repeat(64),
    intent,
    title: `Swap ${intent.amount} ${input.tokenSymbol} → ${output.tokenSymbol}`,
    venue: "RHEA",
    input,
    output,
    inputUnits: units,
    outputUnits: q.outputUnits,
    minimumOutputUnits: q.minimumOutputUnits,
    maximumDebit: `${intent.amount} ${input.tokenSymbol}`,
    limitPrice: null,
    feeNote: `Pool fees included. Gas and any registration: up to ${formatUnits(MAX_NATIVE_GAS_UNITS, { decimals: 24, fractionDigits: 4 })} NEAR from the trading account.`,
    visibility: "public",
    expiresAt: q.expiresAt,
    actionId: null,
    status: "quoted",
  });
  return { kind: "rhea", preview, plan, prepared };
}
