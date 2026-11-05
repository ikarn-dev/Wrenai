import "server-only";
import { ExecutionError } from "@/server/execution/contracts";
import { decimal, plainDecimal, product } from "@/server/research/decimal";
import { squintCoinIndex } from "@/server/squint/client";
import type { SquintIndexCoin } from "@/server/squint/contracts";
import { SquintUnavailable } from "@/server/squint/contracts";
import type { MemecoinRow, MemecoinSort, MemecoinView } from "@/shared/market-pages";

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

function row(coin: SquintIndexCoin, nearUsd: string): MemecoinRow {
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
    asset: null,
  };
}

/** Coin statistics can render as soon as Squint returns. The client joins the independent Intents catalog. */
export async function memecoinView(sort: MemecoinSort): Promise<MemecoinView> {
  const index = await squintCoinIndex(sort).catch((error: unknown) => {
    if (error instanceof SquintUnavailable) {
      throw new ExecutionError("not_ready", error.message);
    }
    throw error;
  });
  return {
    sort,
    coins: index.coins.map((coin) => row(coin, index.near_usd)),
  };
}
