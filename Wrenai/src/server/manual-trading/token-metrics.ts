import "server-only";
import { z } from "zod";
import { coingeckoApiKey } from "@/server/env";
import { decimal, plainDecimal } from "@/server/research/decimal";
import { MarketUnavailable, marketJson } from "@/server/research/market-http";
import type { TokenMetrics } from "@/shared/market-pages";

// Volume, market cap and price change for the Spot table, from CoinGecko's markets endpoint (Demo plan), matched
// by the coingeckoId 1Click lists for each token. One request covers every ID (250 per page). Display only:
// nothing here feeds a quote or the Guard.
const URL_BASE =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&price_change_percentage=1h,24h,7d,30d&ids=";
const MAX_IDS = 250;
/** The Demo plan allows 10,000 calls a month; one read per 5 minutes stays under it even polled all day. */
const FRESH_MS = 5 * 60_000;
/** After a failed read (CoinGecko's keyless limit is tight), wait this long before asking again. */
const COOLDOWN_MS = 60_000;
/** Older figures are dropped rather than shown. */
const KEEP_MS = 10 * 60_000;

const numeric = z
  .string()
  .regex(/^-?\d{1,30}(?:\.\d{1,40})?(?:[eE][-+]?\d{1,2})?$/)
  .nullable()
  .catch(null);
const rowSchema = z.object({
  id: z.string().max(120),
  symbol: z.string().max(80).catch(""),
  name: z.string().max(120).catch(""),
  image: z.string().max(300).nullable().catch(null),
  total_volume: numeric,
  market_cap: numeric,
  price_change_percentage_1h_in_currency: numeric.optional(),
  price_change_percentage_24h_in_currency: numeric.optional(),
  price_change_percentage_7d_in_currency: numeric.optional(),
  price_change_percentage_30d_in_currency: numeric.optional(),
});
const ICON = /^https:\/\/coin-images\.coingecko\.com\/coins\/images\/[\w./-]+(?:\?\d+)?$/;

export interface MetricsSnapshot {
  readonly observedAt: number | null;
  readonly byId: ReadonlyMap<string, TokenMetrics>;
  /** Why there are no figures, for the Spot page; null when they loaded. */
  readonly notice: string | null;
}

const EMPTY: MetricsSnapshot = {
  observedAt: null,
  byId: new Map(),
  notice: "Market data from CoinGecko is unavailable right now, so every listed token is shown.",
};
let lastGood: MetricsSnapshot | null = null;
let failedAt = 0;
let loading: Promise<MetricsSnapshot> | null = null;

function fixed(raw: string | null | undefined, digits: number): string | null {
  return raw === null || raw === undefined ? null : plainDecimal(decimal(raw), digits);
}

function metrics(row: z.infer<typeof rowSchema>): TokenMetrics {
  return {
    coinId: row.id,
    symbol: row.symbol.toLowerCase(),
    name: row.name,
    // The cache-busting query is dropped so next.config.ts can allow this path with no query at all.
    icon: row.image && ICON.test(row.image) ? (row.image.split("?")[0] ?? null) : null,
    volume24h: fixed(row.total_volume, 0),
    marketCap: fixed(row.market_cap, 0),
    change: {
      "1h": fixed(row.price_change_percentage_1h_in_currency, 2),
      "24h": fixed(row.price_change_percentage_24h_in_currency, 2),
      "7d": fixed(row.price_change_percentage_7d_in_currency, 2),
      "30d": fixed(row.price_change_percentage_30d_in_currency, 2),
    },
  };
}

async function load(ids: readonly string[], apiKey: string): Promise<MetricsSnapshot> {
  try {
    const response = await marketJson("CoinGecko", `${URL_BASE}${ids.map(encodeURIComponent).join(",")}`, {
      cacheMs: FRESH_MS,
      headers: { Accept: "application/json", "x-cg-demo-api-key": apiKey },
    });
    const rows = z.array(rowSchema).max(MAX_IDS).parse(response.value);
    lastGood = {
      observedAt: response.capturedAt,
      byId: new Map(rows.map((row) => [row.id, metrics(row)])),
      notice: null,
    };
    return lastGood;
  } catch (error) {
    if (!(error instanceof MarketUnavailable || error instanceof z.ZodError)) {
      throw error;
    }
    // Figures are display-only, so the table falls back to the last good read and says how old it is.
    failedAt = Date.now();
    return fallback();
  }
}

function fallback(): MetricsSnapshot {
  return lastGood && Date.now() - (lastGood.observedAt ?? 0) < KEEP_MS ? lastGood : EMPTY;
}

/** Market figures by CoinGecko ID. 1Click's "custom:" IDs aren't CoinGecko coins and are skipped. */
export async function tokenMetrics(coingeckoIds: readonly string[]): Promise<MetricsSnapshot> {
  const ids = [...new Set(coingeckoIds.filter((id) => /^[a-z0-9-]{1,120}$/.test(id)))]
    .toSorted()
    .slice(0, MAX_IDS);
  const apiKey = coingeckoApiKey();
  if (!apiKey) {
    // Only the Spot table's figures depend on it; prices, quotes and the Perps funding list keep working.
    return { ...EMPTY, notice: "Market data needs COINGECKO_API_KEY in Wrenai/.env." };
  }
  if (ids.length === 0) {
    return { ...EMPTY, notice: null };
  }
  if (Date.now() - failedAt < COOLDOWN_MS) {
    return fallback();
  }
  loading ??= load(ids, apiKey).finally(() => {
    loading = null;
  });
  return loading;
}
