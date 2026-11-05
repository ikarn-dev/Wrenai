import { z } from "zod";
import { manualBalanceSchema, manualPreviewSchema } from "./manual-trading";
import { tradeAssetSchema } from "./trade-preview";

// The market pages poll these over GET route handlers (src/app/api/trading). The browser parses each response
// with the same schema the types come from.

const plainDecimalSchema = z.string().regex(/^-?\d{1,30}(?:\.\d{1,18})?$/);

export const CHANGE_PERIODS = ["1h", "24h", "7d", "30d"] as const;
export type ChangePeriod = (typeof CHANGE_PERIODS)[number];

export const tokenMetricsSchema = z.strictObject({
  /** CoinGecko's coin ID: tokens with the same ID are one asset on different chains or bridges. */
  coinId: z.string().max(120),
  /** CoinGecko's ticker, lowercase ("btc"). */
  symbol: z.string().max(80),
  name: z.string().max(120),
  /** CoinGecko's image URL; next/image fetches it server-side, so the browser never contacts CoinGecko. */
  icon: z
    .string()
    .max(300)
    .regex(/^https:\/\/coin-images\.coingecko\.com\/coins\/images\/[\w./-]+$/)
    .nullable(),
  /** USD, whole dollars, across every market CoinGecko tracks (not only NEAR venues). */
  volume24h: plainDecimalSchema.nullable(),
  marketCap: plainDecimalSchema.nullable(),
  /** Percent price change over each period, two decimals. */
  change: z.strictObject({
    "1h": plainDecimalSchema.nullable(),
    "24h": plainDecimalSchema.nullable(),
    "7d": plainDecimalSchema.nullable(),
    "30d": plainDecimalSchema.nullable(),
  }),
});
export type TokenMetrics = z.infer<typeof tokenMetricsSchema>;

export const spotMarketTokenSchema = tradeAssetSchema.extend({
  coinId: z.string().max(120).optional(),
  price: z.string().max(80).nullable(),
  /** When 1Click last updated the price (epoch ms); its token list is a cached snapshot. */
  priceUpdatedAt: z.number().int().nullable(),
  metrics: tokenMetricsSchema.nullable(),
});
export type SpotMarketToken = z.infer<typeof spotMarketTokenSchema>;

export const spotMarketViewSchema = z.strictObject({
  tokens: z.array(spotMarketTokenSchema).max(1000),
  /** Why tokens carry no market figures (CoinGecko unreachable or not configured); null when they loaded. */
  metricsNotice: z.string().max(200).nullable(),
});
export type SpotMarketView = z.infer<typeof spotMarketViewSchema>;

export const spotMetricsViewSchema = z.strictObject({
  metrics: z.array(tokenMetricsSchema).max(250),
  notice: z.string().max(200).nullable(),
});
export type SpotMetricsView = z.infer<typeof spotMetricsViewSchema>;

/**
 * Hyperliquid's coin icon for a Perps market. Not every market has one; a missing one falls back to the letter
 * mark. Pure, so server and client components can both build it.
 */
export function perpsIcon(market: string): string {
  return `https://app.hyperliquid.xyz/coins/${encodeURIComponent(market)}.svg`;
}

export const perpsMarketRowSchema = z.strictObject({
  name: z.string().max(40),
  mark: z.string().max(80),
  funding: z.string().max(80),
  maxLeverage: z.number().int().positive(),
  sizeDecimals: z.number().int().min(0).max(36),
  /** Percent, two decimals, against Hyperliquid's price a day ago. */
  change24h: plainDecimalSchema.nullable(),
  /** USD, whole dollars: the day's traded notional and open interest at the mark price. */
  volume24h: plainDecimalSchema,
  openInterest: plainDecimalSchema,
});
export type PerpsMarketRow = z.infer<typeof perpsMarketRowSchema>;

export const manualAccountViewSchema = z.strictObject({
  nativeAccountId: z.string().max(100).nullable(),
  perpsAddress: z.string().max(100).nullable(),
  recoveryReady: z.boolean(),
  balances: z.array(manualBalanceSchema).max(500),
  balanceNotice: z.string().max(300).nullable(),
  positions: z
    .array(
      z.strictObject({
        market: z.string().max(40),
        side: z.enum(["long", "short"]),
        quantity: z.string().regex(/^\d{1,80}$/),
        decimals: z.number().int().min(0).max(36),
      }),
    )
    .max(200),
  orders: z.array(manualPreviewSchema).max(50),
});
export type ManualAccountView = z.infer<typeof manualAccountViewSchema>;

export const MEMECOIN_SORTS = ["mcap", "volume", "change", "age"] as const;
export type MemecoinSort = (typeof MEMECOIN_SORTS)[number];

export const memecoinRowSchema = z.strictObject({
  /** The NEAR token contract. */
  token: z.string().max(100),
  symbol: z.string().max(160),
  name: z.string().max(160),
  /** A launchpad or CDN image URL from Squint (next.config.ts allows those hosts only). */
  icon: z
    .string()
    .max(300)
    .regex(/^https:\/\/(?:nearly\.trade\/api\/img|cdn\.dexscreener\.com\/cms\/images)\/[\w./-]+$/)
    .nullable(),
  launchpad: z.string().max(50),
  createdAt: z.number().int().nullable(),
  holders: z.number().int().nonnegative(),
  /** Squint stops counting past 100 holders for coins outside Nearly. */
  holdersCapped: z.boolean(),
  /** USD, whole dollars. */
  marketCap: plainDecimalSchema.nullable(),
  volume24h: plainDecimalSchema.nullable(),
  liquidity: plainDecimalSchema.nullable(),
  /** Percent, two decimals. */
  change24h: plainDecimalSchema.nullable(),
  /** Squint's risk score, 0 (lowest) to 100, and its grade; null until Squint grades the coin. */
  risk: z.number().int().min(0).max(100).nullable(),
  verdict: z.enum(["clean", "caution", "danger"]).nullable(),
  /** The Memecoins screen joins the exact token to the independent NEAR Intents catalog. */
  asset: spotMarketTokenSchema.nullable(),
});
export type MemecoinRow = z.infer<typeof memecoinRowSchema>;

export const memecoinViewSchema = z.strictObject({
  sort: z.enum(MEMECOIN_SORTS),
  coins: z.array(memecoinRowSchema).max(100),
});
export type MemecoinView = z.infer<typeof memecoinViewSchema>;
