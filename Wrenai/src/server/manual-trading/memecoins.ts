import "server-only";
import { registryTradeAsset } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import { decimal, plainDecimal, product } from "@/server/research/decimal";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { MarketUnavailable } from "@/server/research/market-http";
import { squintCoinIndex } from "@/server/squint/client";
import type { SquintIndexCoin } from "@/server/squint/contracts";
import { SquintUnavailable } from "@/server/squint/contracts";
import type { MemecoinRow, MemecoinSort, MemecoinView, SpotMarketToken } from "@/shared/market-pages";

// Image hosts Squint links to that next.config.ts allows. Query strings are dropped so the allowlist can require
// none; relative icon paths have no stated origin and fall back to the letter mark.
const ICON_HOSTS = /^https:\/\/(?:nearly\.trade\/api\/img|cdn\.dexscreener\.com\/cms\/images)\/[\w./-]+$/;

function icon(raw: string | null | undefined): string | null {
  const path = raw?.split("?")[0];
  return path && ICON_HOSTS.test(path) ? path : null;
}

function whole(raw: string | null | undefined): string | null {
  return raw === null || raw === undefined ? null : plainDecimal(decimal(raw), 0);
}

/** Tokens NEAR Intents lists, by asset ID; empty when the registry is unreachable (rows then show no Trade). */
async function listedTokens(): Promise<ReadonlyMap<string, IntentToken>> {
  try {
    return new Map((await intentTokens()).tokens.map((t) => [t.assetId, t]));
  } catch (error) {
    if (error instanceof MarketUnavailable) {
      return new Map();
    }
    throw error;
  }
}

function asset(token: IntentToken | undefined): SpotMarketToken | null {
  if (!token) {
    return null;
  }
  const updated = token.priceUpdatedAt ? Date.parse(token.priceUpdatedAt) : Number.NaN;
  return {
    ...registryTradeAsset(token),
    price: token.price ?? null,
    priceUpdatedAt: Number.isFinite(updated) ? updated : null,
    metrics: null,
  };
}

function row(coin: SquintIndexCoin, nearUsd: string, listed: IntentToken | undefined): MemecoinRow {
  const created = coin.created_at ? Date.parse(coin.created_at) : Number.NaN;
  return {
    token: coin.token,
    symbol: coin.symbol,
    name: coin.name,
    icon: icon(coin.icon),
    launchpad: coin.launchpad,
    createdAt: Number.isFinite(created) ? created : null,
    holders: coin.holders,
    holdersCapped: coin.holders_capped,
    marketCap: whole(coin.fdv_usd),
    volume24h: whole(coin.volume_24h_usd),
    // Squint reports liquidity in NEAR; its own near_usd converts it, so both figures share one price.
    liquidity:
      coin.liquidity_near === null
        ? null
        : plainDecimal(product(decimal(coin.liquidity_near), decimal(nearUsd)), 0),
    change24h:
      coin.change_24h_pct === null || coin.change_24h_pct === undefined
        ? null
        : plainDecimal(decimal(coin.change_24h_pct), 2),
    risk: coin.risk,
    verdict: coin.verdict,
    asset: asset(listed),
  };
}

/** The Memecoins table: Squint's coin index for one sort, with NEAR Intents listings marked tradable. */
export async function memecoinView(sort: MemecoinSort): Promise<MemecoinView> {
  const [index, listed] = await Promise.all([
    squintCoinIndex(sort).catch((error: unknown) => {
      if (error instanceof SquintUnavailable) {
        throw new ExecutionError("not_ready", error.message);
      }
      throw error;
    }),
    listedTokens(),
  ]);
  return {
    sort,
    coins: index.coins.map((coin) => row(coin, index.near_usd, listed.get(`nep141:${coin.token}`))),
  };
}
