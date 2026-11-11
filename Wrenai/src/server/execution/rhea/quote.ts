import "server-only";
import { z } from "zod";
import { assetUsdPrice } from "@/server/engine/instruction-price";
import { memeDclQuote } from "@/server/engine/meme-price";
import { callViewFunction, finalBlockTime } from "@/server/near/rpc";
import { MarketUnavailable } from "@/server/research/market-http";
import { quoteRheaNative } from "@/server/wallet-swap/rhea-native";
import { isNativeNearPayoutPair } from "@/shared/agent-instructions";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeAsset, TradeQuote } from "@/shared/trade-preview";
import { WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_RHEA_POOL, WALLET_SWAP_USDC } from "@/shared/wallet-swap";
import { ExecutionError } from "../contracts";
import { executionHash } from "../records";
import { RHEA_DCL, rheaQuoteSchema } from "./contracts";

export async function readDclPairPool(input: string, output: string): Promise<string> {
  const token = input === "nep141:wrap.near" ? output.slice(7) : input.slice(7);
  // Factory provenance is only route discovery. Meme admission independently checks all code/LP pins.
  const launch = z
    .object({
      token: z.literal(token),
      quote: z.literal("wrap.near"),
      pool_id: z.string().min(5).max(200),
      step: z.literal("Done"),
      inflight: z.literal(false),
    })
    .parse((await callViewFunction("nearlytrade.near", "get_launch_by_token", { token })).value);
  if (![input, output].includes("nep141:wrap.near")) {
    throw new ExecutionError("not_ready", "This native route requires the token's wNEAR pair.");
  }
  return launch.pool_id;
}
export async function quoteRhea(
  input: TradeAsset,
  output: TradeAsset,
  units: string,
  slippageBps: number,
  poolId: string,
): Promise<z.infer<typeof rheaQuoteSchema>> {
  if (isNativeNearPayoutPair(input.assetId, output.assetId)) {
    if (poolId !== WALLET_SWAP_RHEA_POOL || input.decimals !== 6 || output.decimals !== 24) {
      throw new ExecutionError("not_ready", "This pool does not match the verified native NEAR route.");
    }
    const [quote, price] = await Promise.all([
      quoteRheaNative(units, slippageBps, 1),
      assetUsdPrice(WALLET_SWAP_NATIVE_OUTPUT),
    ]);
    const now = Date.now();
    if (now - price.observedAt >= 5000) {
      throw new MarketUnavailable("Current NEAR price");
    }
    const proceeds = BigInt(quote.outputUnits) * price.n * 1_000_000n;
    const denominator = 10n ** 24n * price.d;
    return rheaQuoteSchema.parse({
      ...quote,
      poolId,
      input,
      output,
      inputUnits: units,
      slippageBps,
      // The debit is the USDC spent at face value (6 decimals = micro-USD). Valuing it by the proceeds made
      // amounts equal to a limit exceed it whenever RHEA was cheaper than the reference book.
      inputMicroUsd: units,
      // Independently priced proceeds round down.
      outputMicroUsd: proceeds >= denominator ? (proceeds / denominator).toString() : null,
      observedAt: now,
      expiresAt: now + 60_000,
    });
  }
  const reading = await callViewFunction(RHEA_DCL, "get_pool", { pool_id: poolId });
  const pool = z
    .object({
      pool_id: z.literal(poolId),
      token_x: z.string(),
      token_y: z.string(),
      state: z.literal("Running"),
      total_liquidity: positiveTokenUnitsSchema,
      tax: z.null(),
      whitelist: z.null(),
    })
    .parse(reading.value);
  if (
    !reading.blockHash ||
    pool.token_x === pool.token_y ||
    ![pool.token_x, pool.token_y].includes(input.assetId.slice(7)) ||
    ![pool.token_x, pool.token_y].includes(output.assetId.slice(7)) ||
    input.assetId === output.assetId
  ) {
    throw new ExecutionError("not_ready", "The native pool does not match the exact token pair.");
  }
  const at = await finalBlockTime(reading.blockHash);
  if (at > Date.now() + 1000 || Date.now() - at >= 15000) {
    throw new ExecutionError("not_ready", "The finalized pool observation is stale.");
  }
  const amount = await memeDclQuote(
      poolId,
      input.assetId.slice(7),
      output.assetId.slice(7),
      BigInt(units),
      reading.blockHash,
    ),
    minimum = (amount * BigInt(10000 - slippageBps) + 9999n) / 10000n;
  const { inputMicroUsd, outputMicroUsd } = await pairValue(input, output, BigInt(units), amount);
  return rheaQuoteSchema.parse({
    poolId,
    input,
    output,
    inputUnits: units,
    outputUnits: amount.toString(),
    minimumOutputUnits: minimum.toString(),
    inputMicroUsd: inputMicroUsd.toString(),
    outputMicroUsd: outputMicroUsd === null ? null : outputMicroUsd.toString(),
    blockHash: reading.blockHash,
    observedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    slippageBps,
  });
}
/**
 * USD values for a public pair, from whichever leg has an independent price: USDC at face value (6 decimals are
 * micro-USD), or wNEAR at the timestamped NEAR book. The debit is the input's value, or the expected proceeds
 * when only the output is priced; risk debits round up and priced proceeds round down.
 */
async function pairValue(
  input: TradeAsset,
  output: TradeAsset,
  units: bigint,
  amount: bigint,
): Promise<{ inputMicroUsd: bigint; outputMicroUsd: bigint | null }> {
  if (input.assetId === WALLET_SWAP_USDC || output.assetId === WALLET_SWAP_USDC) {
    return input.assetId === WALLET_SWAP_USDC
      ? { inputMicroUsd: units, outputMicroUsd: null }
      : { inputMicroUsd: amount, outputMicroUsd: amount };
  }
  const nearUnits =
    input.assetId === "nep141:wrap.near" ? units : output.assetId === "nep141:wrap.near" ? amount : 0n;
  const price = await assetUsdPrice("nep141:wrap.near"),
    numerator = nearUnits * price.n * 1000000n,
    denominator = 10n ** 24n * price.d,
    value = (numerator + denominator - 1n) / denominator;
  if (Date.now() - price.observedAt >= 5000 || value <= 0n) {
    throw new ExecutionError("not_ready", "The native trade's independent value could not be verified.");
  }
  return {
    inputMicroUsd: value,
    outputMicroUsd:
      output.assetId === "nep141:wrap.near" && numerator >= denominator ? numerator / denominator : null,
  };
}
export function rheaTradeQuote(quote: z.infer<typeof rheaQuoteSchema>, accountId: string): TradeQuote {
  return {
    provider: "rhea",
    scope: "native_near",
    inputAssetId: quote.input.assetId,
    outputAssetId: quote.output.assetId,
    inputUnits: quote.inputUnits,
    outputUnits: quote.outputUnits,
    minOutputUnits: quote.minimumOutputUnits,
    inputMicroUsd: quote.inputMicroUsd,
    // Historical envelopes without a proceeds valuation remain unknown, never inferred from a debit.
    outputMicroUsd: ["nep141:wrap.near", WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_USDC].includes(
      quote.output.assetId,
    )
      ? (quote.outputMicroUsd ?? null)
      : null,
    slippageBps: quote.slippageBps,
    appFeeBps: 0,
    capturedAt: quote.observedAt,
    expiresAt: quote.expiresAt,
    quoteHash: executionHash(quote),
    recipient: accountId,
    refundTo: accountId,
    feeNote:
      "Pool fees are included in the output. Native gas and any token registration are paid separately.",
  };
}
