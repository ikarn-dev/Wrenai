import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import type { HlUsdSend } from "@/shared/perps-return";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import { tradeAssetSchema } from "@/shared/trade-preview";
import { ExecutionError } from "../contracts";
import type { DefiPlan } from "../defi-contracts";
import { providerSlippageBps, verifiedProviderQuote } from "../oneclick-quote";
import { executionHash, type LedgerAction } from "../records";
import { HYPERLIQUID_BRIDGE_USDC, hlAddressSchema, perpsCashAssetId } from "./contracts";
import { hlText } from "./decimal";

export const returnRecordSchema = z.strictObject({
  format: z.literal("perps-return-v1"),
  requestId: z.uuid(),
  agentId: z.uuid(),
  agentRevision: z.number().int().positive(),
  strategyVersion: z.number().int().positive(),
  ownerAccountId: z.string().min(2).max(64),
  rootId: z.uuid(),
  address: hlAddressSchema,
  debitUnits: positiveTokenUnitsSchema,
  bridgeUnits: positiveTokenUnitsSchema,
  beforeCashUnits: positiveTokenUnitsSchema,
  output: tradeAssetSchema,
  slippageBps: z.number().int().min(1).max(500),
  maximumProviderFeeBps: z.number().int().min(0).max(2000),
  quotedAt: z.number().int().positive().safe(),
  expiresAt: z.number().int().positive().safe(),
  requestDeadline: z.iso.datetime(),
  providerDeadline: z.iso.datetime(),
  depositAddress: hlAddressSchema,
  providerQuote: z.unknown(),
});
export type PerpsReturnRecord = z.infer<typeof returnRecordSchema>;
export function returnQuoteRequest(
  saved: Pick<
    PerpsReturnRecord,
    "bridgeUnits" | "output" | "address" | "ownerAccountId" | "requestDeadline" | "slippageBps"
  >,
): QuoteRequest {
  return {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: providerSlippageBps(saved.slippageBps),
    originAsset: HYPERLIQUID_BRIDGE_USDC,
    destinationAsset: saved.output.assetId,
    amount: saved.bridgeUnits,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
    recipient: saved.ownerAccountId,
    refundTo: saved.address,
    deadline: saved.requestDeadline,
    quoteWaitingTimeMs: 0,
    appFees: [],
  };
}
export function verifiedReturnQuote(
  saved: PerpsReturnRecord,
  now: number,
): ReturnType<typeof verifiedProviderQuote> {
  if (
    BigInt(saved.debitUnits) !== BigInt(saved.bridgeUnits) / 100n + 1_000_000n ||
    BigInt(saved.bridgeUnits) % 100n !== 0n ||
    BigInt(saved.bridgeUnits) < 50_000_000n
  ) {
    throw new ExecutionError("conflict", "The return source amount or transfer fee changed.");
  }
  const quote = verifiedProviderQuote(
    saved.providerQuote,
    returnQuoteRequest(saved),
    "hyperliquid",
    saved.quotedAt,
    saved.slippageBps,
  );
  const provider = z
    .object({
      quote: z.object({
        depositAddress: z.literal(saved.depositAddress),
        deadline: z.literal(saved.providerDeadline),
        depositMemo: z.union([z.literal(""), z.null()]).optional(),
      }),
    })
    .parse(saved.providerQuote);
  if (
    quote.appFeeBps > saved.maximumProviderFeeBps ||
    Date.parse(provider.quote.deadline) <= now ||
    saved.expiresAt > quote.expiresAt ||
    saved.expiresAt <= now ||
    now < saved.quotedAt - 1000
  ) {
    throw new ExecutionError("not_ready", "The return quote expired or changed its reviewed fee.");
  }
  return quote;
}
export function returnTransferTemplate(saved: PerpsReturnRecord): Omit<HlUsdSend, "time"> {
  return {
    type: "usdSend",
    signatureChainId: "0x66eee",
    hyperliquidChain: "Mainnet",
    destination: saved.depositAddress,
    amount: hlText(BigInt(saved.debitUnits), 6),
  };
}
export function validateReturnPlan(plan: DefiPlan, saved: PerpsReturnRecord, at: number): void {
  const quote = verifiedReturnQuote(saved, at);
  const cash = [
    { assetId: perpsCashAssetId(saved.address), maxDebitUnits: saved.debitUnits, minCreditUnits: "0" },
    {
      assetId: saved.output.assetId,
      scope: "confidential",
      maxDebitUnits: "0",
      minCreditUnits: quote.minOutputUnits,
    },
  ];
  if (
    !plan.returnFunds ||
    !plan.funding ||
    plan.fundingFeeUnits !== "1000000" ||
    plan.operation !== "transfer" ||
    plan.scope !== "hyperliquid" ||
    plan.venueId !== "hyperliquid" ||
    (plan.budgetMode !== "per_agent" && plan.budgetMode !== "manual") ||
    plan.positions.length !== 0 ||
    plan.agentId !== saved.agentId ||
    plan.agentRevision !== saved.agentRevision ||
    plan.strategyVersion !== saved.strategyVersion ||
    plan.requestId !== saved.requestId ||
    plan.notionalMicroUsd !== saved.debitUnits ||
    plan.quoteHash !== quote.quoteHash ||
    plan.quoteId !== saved.depositAddress ||
    plan.payloadHash !== executionHash(returnTransferTemplate(saved)) ||
    plan.recipient !== saved.ownerAccountId ||
    plan.slippageBps !== saved.slippageBps ||
    plan.providerFeeBps !== quote.appFeeBps ||
    plan.expiresAt !== saved.expiresAt ||
    executionHash(plan.cash) !== executionHash(cash)
  ) {
    throw new ExecutionError(
      "conflict",
      "The return plan differs from its confirmed amounts, destination or fee preview.",
    );
  }
}
export async function readReturnRecord(db: AppDatabase, action: LedgerAction): Promise<PerpsReturnRecord> {
  const rows = await db
    .select({ detail: executionEvents.detailJson })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "perps_return_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "This return has no unique immutable preparation record.");
  }
  return returnRecordSchema.parse(JSON.parse(rows[0].detail));
}
