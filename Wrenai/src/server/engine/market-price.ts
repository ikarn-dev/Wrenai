import "server-only";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { quoteMicroUsd } from "@/server/execution/oneclick-quote";
import { tradingResponseJson } from "@/server/execution/trading-http";
import { decimal } from "@/server/research/decimal";
import type { AssetSymbol } from "@/shared/agents";

const positiveDecimal = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,36})?$/);
const levelSchema = z.tuple([positiveDecimal, positiveDecimal, z.number().int().positive()]);
const bookSchema = z.object({
  bids: z.array(levelSchema).length(1),
  asks: z.array(levelSchema).length(1),
  time: z.iso.datetime(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  auction_mode: z.literal(false),
});
export interface MarketPrice {
  readonly symbol: AssetSymbol;
  readonly priceMicroUsd: bigint;
  readonly marketAt: number;
  readonly capturedAt: number;
}

async function marketBook(symbol: AssetSymbol): Promise<z.infer<typeof bookSchema>> {
  try {
    return bookSchema.parse(
      await tradingResponseJson(
        await fetch(`https://api.exchange.coinbase.com/products/${symbol}-USD/book?level=1`, {
          cache: "no-store",
          redirect: "error",
          headers: { "User-Agent": "wrenai/0.1" },
          signal: AbortSignal.timeout(3000),
        }),
        8000,
      ),
    );
  } catch {
    throw new ExecutionError(
      "not_ready",
      "Fresh market data could not be validated. Trading waits for a valid market snapshot.",
    );
  }
}

/** Poll the timestamped L1 book, not the last-trade ticker, which can be old even in a healthy market.
 * https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book
 */
export async function freshMarketPrice(symbol: AssetSymbol): Promise<MarketPrice> {
  if (symbol === "USDC" || symbol === "USDT") {
    throw new ExecutionError("not_ready", "This trigger needs a supported underlying USD market.");
  }
  return freshAssetUsdPrice(symbol);
}

export async function freshAssetUsdPrice(symbol: AssetSymbol): Promise<MarketPrice> {
  const book = await marketBook(symbol);
  const capturedAt = Date.now();
  const marketAt = Date.parse(book.time);
  const bid = book.bids[0],
    ask = book.asks[0];
  if (!bid || !ask || decimal(bid[1]).n <= 0n || decimal(ask[1]).n <= 0n) {
    throw new ExecutionError("not_ready", "The market reference has no usable liquidity.");
  }
  const bidPrice = quoteMicroUsd(bid[0], false),
    askPrice = quoteMicroUsd(ask[0], true);
  // The midpoint is a reference only. Actual input, fees and minimum output come from the signed execution quote.
  const priceMicroUsd = (bidPrice + askPrice) / 2n;
  if (
    capturedAt - marketAt >= 5000 ||
    marketAt > capturedAt + 1000 ||
    priceMicroUsd <= 0n ||
    bidPrice <= 0n ||
    bidPrice >= askPrice ||
    (askPrice - bidPrice) * 10_000n > priceMicroUsd * 100n
  ) {
    throw new ExecutionError(
      "not_ready",
      "The market reference is stale or invalid. New trigger trades are blocked.",
    );
  }
  return { symbol, priceMicroUsd, marketAt, capturedAt };
}
