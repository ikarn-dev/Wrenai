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
    | "/v0/submit-intent"
    | "/v0/deposit/submit",
  body: unknown,
  signal?: AbortSignal,
  sessionToken?: string,
): Promise<unknown> {
  const credential = z.object({ ONECLICK_JWT: z.string().trim().min(1).max(8000) }).safeParse(process.env);
  const response = await fetch(`https://1click.chaindefuser.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "wrenai/0.1",
      ...(credential.success ? { "X-API-Key": credential.data.ONECLICK_JWT } : {}),
      ...(sessionToken ? { "User-Session": sessionToken } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  });
  return tradingResponseJson(response, 256_000);
}

/** Leave room for provider rounding while enforcing the original cap on the signed quote. */
export function providerSlippageBps(maximumSlippageBps: number): number {
  return Math.max(0, maximumSlippageBps - 1);
}

export function dryQuoteRequest(
  accountId: string,
  inputAssetId: string,
  outputAssetId: string,
  inputUnits: string,
  maximumSlippageBps: number,
  scope: ExecutionScope,
  now: number,
): QuoteRequest {
  if (scope !== "confidential" && scope !== "intents") {
    throw new ExecutionError("not_ready", "This account scope cannot use an Intents quote.");
  }
  return {
    dry: true,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: providerSlippageBps(maximumSlippageBps),
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
  maximumSlippageBps: number,
): TradeQuote {
  const parsed = z
    .object({
      // Unsigned metadata: the SDK's signed hash covers only quoteRequest, quote and timestamp (hashQuote in
      // @defuse-protocol/one-click-sdk-typescript), and 1Click leaves it out of the quote echoed by /v0/status.
      // Fresh /v0/quote responses still carry it, so their hashes keep the stored format.
      correlationId: z.string().max(256).optional(),
      timestamp: z.iso.datetime(),
      signature: z.string().max(512),
      quoteRequest: z.looseObject({
        dry: z.literal(request.dry),
        swapType: z.literal(request.swapType),
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
  // The quote 1Click echoes in /v0/status fills unset request fields with null rather than leaving them out
  // (observed Nov 2026), so null reads as "not set" here, like an absent field. Any real value still fails.
  z.object({ quoteWaitingTimeMs: z.literal(request.quoteWaitingTimeMs ?? 0).nullish() }).parse(
    parsed.quoteRequest,
  );
  z.object({ refundFee: tokenUnitsSchema.nullish(), withdrawFee: tokenUnitsSchema.nullish() }).parse(
    parsed.quote,
  );
  const unexpected = [
    "rebates",
    "customRecipientMsg",
    "virtualChainRecipient",
    "virtualChainRefundRecipient",
    "insured",
  ].find((key) => {
    const value = parsed.quoteRequest[key];
    return value !== undefined && value !== null && value !== false && JSON.stringify(value) !== "[]";
  });
  if (unexpected !== undefined) {
    // The field's name is protocol vocabulary, not a secret; naming it lets a blocked return be diagnosed.
    throw new ExecutionError(
      "not_ready",
      `The quote added unapproved fees or routing instructions (${unexpected}).`,
    );
  }
  const { appFees } = z
    .object({
      appFees: z
        .array(z.object({ recipient: z.string().min(2).max(64), fee: z.number().int().min(0).max(2000) }))
        .max(10)
        .nullish()
        .transform((fees) => fees ?? []),
    })
    .parse(parsed.quoteRequest);
  const appFeeBps = appFees.reduce((sum, fee) => sum + fee.fee, 0);
  const quotedAt = Date.parse(parsed.timestamp);
  // The SDK's QuoteResponse type requires correlationId, but its signed hash excludes it, so an empty value for a
  // status echo verifies exactly the same signed content. `parsed` (and so quoteHash) is left unchanged.
  const signed = { ...parsed, correlationId: parsed.correlationId ?? "" };
  if (quotedAt > capturedAt + 1000 || capturedAt - quotedAt >= 15_000 || !verifyQuoteSignature(signed)) {
    throw new ExecutionError("not_ready", "The quote signature or freshness check failed.");
  }
  const quote = parsed.quote;
  const exactOutput = request.swapType === QuoteRequest.swapType.EXACT_OUTPUT;
  const minimum = exactOutput
    ? BigInt(request.amount)
    : (BigInt(quote.amountOut) * BigInt(10_000 - maximumSlippageBps) + 9999n) / 10_000n;
  if (
    (exactOutput
      ? quote.amountOut !== request.amount ||
        BigInt(quote.minAmountIn) <= 0n ||
        BigInt(quote.amountIn) * 10_000n >
          BigInt(quote.minAmountIn) * BigInt(10_000 + maximumSlippageBps) + 10_000n
      : quote.amountIn !== request.amount) ||
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
  maximumSlippageBps: number,
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
  sessionToken?: string,
): Promise<TradeQuote> {
  const request = dryQuoteRequest(
    accountId,
    inputAssetId,
    outputAssetId,
    inputUnits,
    slippageBps,
    scope,
    Date.now(),
  );
  return verifiedDryQuote(
    await oneClickJson("/v0/quote", request, signal, sessionToken),
    request,
    scope,
    Date.now(),
    slippageBps,
  );
}
