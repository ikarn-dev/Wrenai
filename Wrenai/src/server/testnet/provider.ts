import "server-only";
import { QuoteRequest, verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { base58 } from "@scure/base";
import { z } from "zod";
import { isTransportFailure, ProviderUnavailable } from "@/server/execution/contracts";
import { tradingResponseJson } from "@/server/execution/trading-http";
import { type TestnetLocation, testnetAsset } from "@/shared/testnet";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";
import { TestnetError, testnetEnv } from "./config";
import { testnetChain, testnetRpc } from "./rpc";

const BASE = "https://www.usetidepool.tech";
export const TIDEPOOL_QUOTE_KEY = "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY";
export const VERIFIER = "verifier.tidepool-sandbox.testnet";
export const VERIFIER_HASH = "a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547";
export async function tidepool(
  path: "/v0/health" | "/v0/tokens" | "/v0/quote" | "/v0/status",
  body?: unknown,
  deposit?: string,
): Promise<unknown> {
  testnetEnv();
  try {
    const r = await fetch(
      `${BASE}${path}${deposit ? `?depositAddress=${encodeURIComponent(deposit)}` : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      },
    );
    return await tradingResponseJson(r, 512000);
  } catch (error) {
    // A dropped connection, timeout or 429/5xx is an outage: callers wait and retry rather than fail for good.
    if (isTransportFailure(error) || error instanceof ProviderUnavailable) {
      throw new TestnetError(
        "unavailable",
        "The testnet trading provider is unreachable. Try again shortly.",
      );
    }
    throw error;
  }
}

const healthSchema = z.object({
  network: z.literal("testnet"),
  verifier: z.literal(VERIFIER),
  ok: z.literal(true),
  checks: z.object({
    // Tidepool's "fallback" source is static prices, not live ones; orders wait for its live feed.
    prices: z.object({
      ok: z.literal(true),
      source: z.literal("coingecko"),
      updatedAt: z.iso.datetime(),
    }),
  }),
});
export async function verifierReady(): Promise<void> {
  const [rawCode] = await Promise.all([
    testnetRpc("query", { request_type: "view_account", account_id: VERIFIER, finality: "final" }),
    testnetChain(),
  ]);
  const code = z.object({ code_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/) }).parse(rawCode);
  // NEAR's finalized account code_hash is the base58-encoded WASM SHA-256. Avoid downloading the full WASM per quote.
  if (Buffer.from(base58.decode(code.code_hash)).toString("hex") !== VERIFIER_HASH) {
    throw new TestnetError("unavailable", "Testnet verifier code changed. Review is required.");
  }
}
export async function providerReady(): Promise<void> {
  const [rawHealth] = await Promise.all([tidepool("/v0/health"), verifierReady()]);
  // Degraded health (pricing down, a fallback price source) pauses new orders; it is an outage, not a bad request.
  // Before, the strict parse threw a ZodError that exhausted the agent workflow's retries and ended it.
  const parsed = healthSchema.safeParse(rawHealth);
  if (!parsed.success) {
    throw new TestnetError("unavailable", "Live testnet pricing is unavailable. New orders are paused.");
  }
  const health = parsed.data;
  const age = Date.now() - Date.parse(health.checks.prices.updatedAt);
  if (age < -1000 || age > 60000) {
    throw new TestnetError("unavailable", "Live testnet pricing is stale. New orders are paused.");
  }
}

const fields = z
  .looseObject({
    amountIn: positiveTokenUnitsSchema,
    amountOut: positiveTokenUnitsSchema,
    minAmountIn: tokenUnitsSchema,
    minAmountOut: positiveTokenUnitsSchema,
    amountInFormatted: z.string(),
    amountOutFormatted: z.string(),
    amountInUsd: z.string(),
    amountOutUsd: z.string(),
    depositAddress: z.string().optional(),
    depositMemo: z.string().optional(),
    deadline: z.string().optional(),
    timeEstimate: z.number(),
    timeWhenInactive: z.string().optional(),
    refundFee: tokenUnitsSchema.optional(),
    withdrawFee: tokenUnitsSchema.optional(),
  })
  .transform(
    ({ depositAddress, depositMemo, deadline, timeWhenInactive, refundFee, withdrawFee, ...required }) => ({
      ...required,
      ...(depositAddress === undefined ? {} : { depositAddress }),
      ...(depositMemo === undefined ? {} : { depositMemo }),
      ...(deadline === undefined ? {} : { deadline }),
      ...(timeWhenInactive === undefined ? {} : { timeWhenInactive }),
      ...(refundFee === undefined ? {} : { refundFee }),
      ...(withdrawFee === undefined ? {} : { withdrawFee }),
    }),
  );
export const tideQuoteSchema = z.object({
  correlationId: z.string(),
  timestamp: z.iso.datetime(),
  signature: z.string(),
  quoteRequest: z.looseObject({
    dry: z.boolean(),
    swapType: z.literal(QuoteRequest.swapType.EXACT_INPUT),
    slippageTolerance: z.number(),
    originAsset: z.string(),
    destinationAsset: z.string(),
    amount: positiveTokenUnitsSchema,
    depositType: z.enum([QuoteRequest.depositType.ORIGIN_CHAIN, QuoteRequest.depositType.INTENTS]),
    refundTo: z.string(),
    refundType: z.enum([QuoteRequest.refundType.ORIGIN_CHAIN, QuoteRequest.refundType.INTENTS]),
    recipient: z.string(),
    recipientType: z.enum([QuoteRequest.recipientType.DESTINATION_CHAIN, QuoteRequest.recipientType.INTENTS]),
    deadline: z.iso.datetime(),
  }),
  quote: fields,
});
export type TideQuote = z.infer<typeof tideQuoteSchema>;
/**
 * The quote's minimum output misses the price limit only by rounding: on a small output one smallest unit is a large
 * share, so the provider's rounded-down minimum lands just past the limit. Carries the quoted output so the request
 * can be repeated with a tolerance that fits.
 */
export class SlippageRounding extends TestnetError {
  constructor(readonly amountOut: bigint) {
    super("limit", "The quote exceeds the selected slippage limit.");
  }
}
export function validateTideQuote(
  raw: unknown,
  expected: {
    /** The tolerance sent to Tidepool, in bps; one below the cap unless a rounding retry tightened it. */
    requested?: number;
    input: string;
    output: string;
    units: string;
    account: string;
    slippage: number;
    dry: boolean;
    deadline: string;
    location?: TestnetLocation;
    outputLocation?: TestnetLocation;
  },
  now: number,
  key: string,
): TideQuote {
  const q = tideQuoteSchema.parse(raw),
    r = q.quoteRequest;
  if (
    r.depositType !== ((expected.location ?? "wallet") === "intents" ? "INTENTS" : "ORIGIN_CHAIN") ||
    r.refundType !== ((expected.location ?? "wallet") === "intents" ? "INTENTS" : "ORIGIN_CHAIN") ||
    r.recipientType !==
      ((expected.outputLocation ?? "wallet") === "intents" ? "INTENTS" : "DESTINATION_CHAIN") ||
    r.dry !== expected.dry ||
    r.originAsset !== expected.input ||
    r.destinationAsset !== expected.output ||
    r.amount !== expected.units ||
    r.refundTo !== expected.account ||
    r.recipient !== expected.account ||
    r.slippageTolerance !== (expected.requested ?? expected.slippage - 1) ||
    r.deadline !== expected.deadline ||
    q.quote.amountIn !== expected.units ||
    now - Date.parse(q.timestamp) > 15000 ||
    Date.parse(q.timestamp) > now + 1000 ||
    !verifyQuoteSignature(q, key)
  ) {
    throw new TestnetError("unavailable", "The testnet quote could not be verified.");
  }
  if (BigInt(q.quote.minAmountOut) * 10000n < BigInt(q.quote.amountOut) * BigInt(10000 - expected.slippage)) {
    throw new SlippageRounding(BigInt(q.quote.amountOut));
  }
  if (!expected.dry && (!q.quote.depositAddress || q.quote.depositMemo)) {
    throw new TestnetError("unavailable", "This deposit route is not supported.");
  }
  return q;
}
export async function testnetQuote(
  input: string,
  output: string,
  units: string,
  account: string,
  slippage: number,
  dry = false,
  location: TestnetLocation = "wallet",
  outputLocation: TestnetLocation = "wallet",
): Promise<TideQuote> {
  if (input === output || !testnetAsset(input).contract || !testnetAsset(output).contract) {
    throw new TestnetError(
      "invalid_input",
      "Tidepool cannot swap native NEAR. Select an exact supported test token pair.",
    );
  }
  await providerReady();
  const request = (requested: number) =>
    requestQuote({ input, output, units, account, slippage, requested, dry, location, outputLocation });
  try {
    return await request(slippage - 1);
  } catch (error) {
    if (!(error instanceof SlippageRounding)) {
      throw error;
    }
    // One smallest output unit is ceil(10000 / out) bps of this order; ask for that much less tolerance so the
    // rounded-down minimum still sits inside the user's limit. The limit itself never widens.
    const requested = slippage - Number((10000n + error.amountOut - 1n) / error.amountOut) - 1;
    if (requested < 1 || error.amountOut === 0n) {
      throw new TestnetError(
        "invalid_input",
        `This order is too small to stay within its ${slippage / 100}% price limit. Raise the amount per order.`,
      );
    }
    return request(requested);
  }
}
async function requestQuote(q: {
  input: string;
  output: string;
  units: string;
  account: string;
  slippage: number;
  requested: number;
  dry: boolean;
  location: TestnetLocation;
  outputLocation: TestnetLocation;
}): Promise<TideQuote> {
  const deadline = new Date(Date.now() + 120000).toISOString();
  const body = {
    dry: q.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: q.requested,
    originAsset: q.input,
    destinationAsset: q.output,
    amount: q.units,
    depositType: q.location === "intents" ? "INTENTS" : "ORIGIN_CHAIN",
    refundTo: q.account,
    refundType: q.location === "intents" ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: q.account,
    recipientType: q.outputLocation === "intents" ? "INTENTS" : "DESTINATION_CHAIN",
    deadline,
  };
  return validateTideQuote(
    await tidepool("/v0/quote", body),
    { ...q, deadline },
    Date.now(),
    TIDEPOOL_QUOTE_KEY,
  );
}
