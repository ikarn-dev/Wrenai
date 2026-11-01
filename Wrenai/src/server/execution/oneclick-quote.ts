import "server-only";
import { QuoteRequest, verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { z } from "zod";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";
import { type TradeQuote, tradeQuoteSchema } from "@/shared/trade-preview";
import type { ExecutionScope } from "./contracts";
import { ExecutionError } from "./contracts";
import { executionHash } from "./records";
import { tradingResponseJson } from "./trading-http";

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,36})?$/);
const quoteFields = z.looseObject({
  amountIn: positiveTokenUnitsSchema,
  amountOut: positiveTokenUnitsSchema,
  minAmountIn: tokenUnitsSchema,
  minAmountOut: positiveTokenUnitsSchema,
  amountInFormatted: decimal,
  amountOutFormatted: decimal,
  amountInUsd: decimal,
  amountOutUsd: decimal,
  timeEstimate: z.number().finite().nonnegative(),
});

/** Round debit valuation up and output valuation down, against the user's risk. */
export function quoteMicroUsd(value: string, roundUp: boolean): bigint {
  const valid = decimal.parse(value);
  const [whole = "0", fraction = ""] = valid.split(".");
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(fraction.padEnd(6, "0").slice(0, 6)) +
    (roundUp && /[1-9]/.test(fraction.slice(6)) ? 1n : 0n)
  );
}

export async function oneClickJson(
  path:
    | "/v0/quote"
    | "/v0/auth/authenticate"
    | "/v0/auth/refresh"
    | "/v0/generate-intent"
    | "/v0/submit-intent",
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const credential = z.object({ ONECLICK_JWT: z.string().trim().min(1).max(8000) }).safeParse(process.env);
  const response = await fetch(`https://1click.chaindefuser.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "wrenai/0.1",
      ...(credential.success ? { "X-API-Key": credential.data.ONECLICK_JWT } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  });
  return tradingResponseJson(response, 256_000);
}

export function dryQuoteRequest(
  accountId: string,
  inputAssetId: string,
  outputAssetId: string,
  inputUnits: string,
  slippageBps: number,
  scope: ExecutionScope,
  now: number,
): QuoteRequest {
  if (scope !== "confidential" && scope !== "intents") {
    throw new ExecutionError("not_ready", "This account scope cannot use an Intents quote.");
  }
  return {
    dry: true,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: slippageBps,
    originAsset: inputAssetId,
    destinationAsset: outputAssetId,
    amount: inputUnits,
    depositType:
      scope === "confidential"
        ? QuoteRequest.depositType.CONFIDENTIAL_INTENTS
        : QuoteRequest.depositType.INTENTS,
    recipientType:
      scope === "confidential"
        ? QuoteRequest.recipientType.CONFIDENTIAL_INTENTS
        : QuoteRequest.recipientType.INTENTS,
    refundType:
      scope === "confidential"
        ? QuoteRequest.refundType.CONFIDENTIAL_INTENTS
        : QuoteRequest.refundType.INTENTS,
    recipient: accountId,
    refundTo: accountId,
    deadline: new Date(now + 120_000).toISOString(),
    quoteWaitingTimeMs: 0,
    appFees: [],
  };
}

export function verifiedProviderQuote(
  raw: unknown,
  request: QuoteRequest,
  scope: ExecutionScope,
  capturedAt: number,
  maximumSlippageBps = request.slippageTolerance,
): TradeQuote {
  const parsed = z
    .object({
      correlationId: z.string().max(256),
      timestamp: z.iso.datetime(),
      signature: z.string().max(512),
      quoteRequest: z.looseObject({
        dry: z.literal(request.dry),
        swapType: z.literal(QuoteRequest.swapType.EXACT_INPUT),
        slippageTolerance: z.literal(request.slippageTolerance),
        originAsset: z.literal(request.originAsset),
        destinationAsset: z.literal(request.destinationAsset),
        amount: z.literal(request.amount),
        depositType: z.literal(request.depositType),
        recipientType: z.literal(request.recipientType),
        refundType: z.literal(request.refundType),
        recipient: z.literal(request.recipient),
        refundTo: z.literal(request.refundTo),
        deadline: z.literal(request.deadline),
      }),
      quote: quoteFields,
    })
    .parse(raw);
  z.object({ quoteWaitingTimeMs: z.literal(request.quoteWaitingTimeMs ?? 0).optional() }).parse(
    parsed.quoteRequest,
  );
  z.object({ refundFee: tokenUnitsSchema.optional(), withdrawFee: tokenUnitsSchema.optional() }).parse(
    parsed.quote,
  );
  const unexpected = [
    "rebates",
    "customRecipientMsg",
    "virtualChainRecipient",
    "virtualChainRefundRecipient",
    "insured",
  ];
  if (
    unexpected.some(
      (key) =>
        parsed.quoteRequest[key] !== undefined &&
        parsed.quoteRequest[key] !== false &&
        JSON.stringify(parsed.quoteRequest[key]) !== "[]",
    )
  ) {
    throw new ExecutionError("not_ready", "The quote added unapproved fees or routing instructions.");
  }
  const { appFees } = z
    .object({
      appFees: z
        .array(z.object({ recipient: z.string().min(2).max(64), fee: z.number().int().min(0).max(2000) }))
        .max(10)
        .default([]),
    })
    .parse(parsed.quoteRequest);
  const appFeeBps = appFees.reduce((sum, fee) => sum + fee.fee, 0);
  const quotedAt = Date.parse(parsed.timestamp);
  if (quotedAt > capturedAt + 1000 || capturedAt - quotedAt >= 15_000 || !verifyQuoteSignature(parsed)) {
    throw new ExecutionError("not_ready", "The quote signature or freshness check failed.");
  }
  const quote = parsed.quote;
  const minimum = (BigInt(quote.amountOut) * BigInt(10_000 - maximumSlippageBps) + 9999n) / 10_000n;
  if (
    quote.amountIn !== request.amount ||
    BigInt(quote.minAmountOut) < minimum ||
    BigInt(quote.minAmountOut) > BigInt(quote.amountOut)
  ) {
    throw new ExecutionError("not_ready", "The quote amount or minimum output exceeds the selected limits.");
  }
  return tradeQuoteSchema.parse({
    provider: "oneclick",
    scope,
    inputAssetId: request.originAsset,
    outputAssetId: request.destinationAsset,
    inputUnits: quote.amountIn,
    outputUnits: quote.amountOut,
    minOutputUnits: quote.minAmountOut,
    inputMicroUsd: quoteMicroUsd(quote.amountInUsd, true).toString(),
    outputMicroUsd: quoteMicroUsd(quote.amountOutUsd, false).toString(),
    slippageBps: maximumSlippageBps,
    appFeeBps,
    capturedAt,
    expiresAt: Math.min(capturedAt + 15_000, quotedAt + 15_000),
    quoteHash: executionHash(parsed),
    recipient: request.recipient,
    refundTo: request.refundTo,
    feeNote:
      "Quoted output includes route and withdrawal costs. Partner fees need a separate configured cap; their metadata is not covered by the provider signature. Signed USD values are estimates, not a separate oracle. " +
      (request.dry
        ? "No deposit or trade was created."
        : "An unfunded provider quote does not authorize execution."),
  });
}

export function verifiedDryQuote(
  raw: unknown,
  request: QuoteRequest,
  scope: ExecutionScope,
  capturedAt: number,
  maximumSlippageBps = request.slippageTolerance,
): TradeQuote {
  if (!request.dry) {
    throw new ExecutionError("not_ready", "A dry preview cannot accept an executable quote.");
  }
  return verifiedProviderQuote(raw, request, scope, capturedAt, maximumSlippageBps);
}

export async function freshDryQuote(
  accountId: string,
  inputAssetId: string,
  outputAssetId: string,
  inputUnits: string,
  slippageBps: number,
  scope: ExecutionScope,
  signal?: AbortSignal,
): Promise<TradeQuote> {
  const request = dryQuoteRequest(
    accountId,
    inputAssetId,
    outputAssetId,
    inputUnits,
    // Leave one basis point for smallest-unit rounding while enforcing the user's original cap below.
    Math.max(0, slippageBps - 1),
    scope,
    Date.now(),
  );
  return verifiedDryQuote(
    await oneClickJson("/v0/quote", request, signal),
    request,
    scope,
    Date.now(),
    slippageBps,
  );
}
