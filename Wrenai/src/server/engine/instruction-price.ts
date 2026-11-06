import "server-only";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction } from "@/server/near/rpc";
import { type Decimal, decimal } from "@/server/research/decimal";
import { rheaPools, rheaQuote } from "@/server/research/rhea";
import { quoteRheaNative } from "@/server/wallet-swap/rhea-native";
import { isNativeNearPayoutPair } from "@/shared/agent-instructions";
import type { TradeAsset } from "@/shared/trade-preview";
import { freshAssetUsdPrice } from "./market-price";

export interface InstructionPrice extends Decimal {
  readonly observedAt: number;
}
const USD_FEEDS = new Map([
  ["native:near", "NEAR"],
  ["nep141:wrap.near", "NEAR"],
  ["nep141:btc.omft.near", "BTC"],
  ["nep141:eth.omft.near", "ETH"],
  ["nep141:sol.omft.near", "SOL"],
] as const);
export async function assetUsdPrice(assetId: string): Promise<InstructionPrice> {
  const entry = [...USD_FEEDS].find(([id]) => id === assetId);
  if (!entry) {
    throw new ExecutionError(
      "not_ready",
      "This exact token has no independent USD feed. Review a quote-token price rule or exact-token alert threshold.",
    );
  }
  const value = await freshAssetUsdPrice(entry[1]);
  return { n: value.priceMicroUsd, d: 1_000_000n, observedAt: value.marketAt };
}
export function comparePrice(a: Decimal, b: Decimal): number {
  const delta = a.n * b.d - b.n * a.d;
  return delta > 0n ? 1 : delta < 0n ? -1 : 0;
}
export function priceScale(value: Decimal, numerator: bigint, denominator = 10_000n): Decimal {
  return { n: value.n * numerator, d: value.d * denominator };
}
/** USD uses a timestamped independent book; arbitrary NEAR pairs use finalized RHEA size quotes. */
export async function instructionPrice(
  base: TradeAsset,
  quote: TradeAsset,
  inputUnits: bigint,
  inputIsQuote: boolean,
  unit: "usd" | "quote_token",
): Promise<InstructionPrice> {
  if (unit === "usd") {
    return assetUsdPrice(base.assetId);
  }
  if (
    isNativeNearPayoutPair(
      inputIsQuote ? quote.assetId : base.assetId,
      inputIsQuote ? base.assetId : quote.assetId,
    )
  ) {
    const observed = await quoteRheaNative(inputUnits.toString(), 1, 1);
    const output = BigInt(observed.outputUnits);
    return inputIsQuote
      ? {
          n: inputUnits * 10n ** BigInt(base.decimals),
          d: output * 10n ** BigInt(quote.decimals),
          observedAt: Date.now(),
        }
      : {
          n: output * 10n ** BigInt(base.decimals),
          d: inputUnits * 10n ** BigInt(quote.decimals),
          observedAt: Date.now(),
        };
  }
  const baseContract = base.assetId.slice(7),
    quoteContract = quote.assetId.slice(7);
  const pools = (await rheaPools()).pools
    .filter(
      (pool) =>
        pool.token_account_ids.includes(baseContract) && pool.token_account_ids.includes(quoteContract),
    )
    .slice(0, 3);
  for (const pool of pools) {
    const actual = await callViewFunction("v2.ref-finance.near", "get_pool", { pool_id: Number(pool.id) });
    const pair = z.object({ token_account_ids: z.array(z.string()).min(2).max(8) }).parse(actual.value);
    if (!pair.token_account_ids.includes(baseContract) || !pair.token_account_ids.includes(quoteContract)) {
      continue;
    }
    const reading = await rheaQuote(
      pool.id,
      inputIsQuote ? quoteContract : baseContract,
      inputIsQuote ? baseContract : quoteContract,
      inputUnits,
    );
    if (reading.amountOut <= 0n || Date.now() - reading.source.observedAt >= 5000) {
      continue;
    }
    return inputIsQuote
      ? {
          n: inputUnits * 10n ** BigInt(base.decimals),
          d: reading.amountOut * 10n ** BigInt(quote.decimals),
          observedAt: reading.source.observedAt,
        }
      : {
          n: reading.amountOut * 10n ** BigInt(base.decimals),
          d: inputUnits * 10n ** BigInt(quote.decimals),
          observedAt: reading.source.observedAt,
        };
  }
  throw new ExecutionError(
    "not_ready",
    "No verified RHEA pool can quote this exact token pair and size. No price trigger was accepted.",
  );
}
export function priceCondition(price: Decimal, direction: "above" | "below", threshold: string): boolean {
  const comparison = comparePrice(price, decimal(threshold));
  return direction === "above" ? comparison >= 0 : comparison <= 0;
}
