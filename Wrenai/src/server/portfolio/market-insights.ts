import "server-only";
import { displaySnapshot } from "@/server/manual-trading/display-snapshot";
import { perpsMarketRows, spotMarketView } from "@/server/manual-trading/markets";
import { memecoinView } from "@/server/manual-trading/memecoins";
import { perpsIcon } from "@/shared/market-pages";
import {
  INSIGHT_ROWS,
  type InsightCard,
  type InsightRow,
  type ListInsight,
  type SpotInsight,
  TICKER_ROWS,
  type TickerInsight,
} from "@/shared/portfolio-insights";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";

// Movers below this daily volume are mostly thin markets, so they are left out.
const MIN_MOVER_VOLUME_USD = 1_000_000;

/** Display-only ordering of decimal strings. */
function numeric(value: string | null): number {
  return value === null ? 0 : Number(value);
}

// One spot read per minute feeds both the movers card and the ticker. The spot list covers every chain NEAR
// Intents routes to.
const spotSnapshot = displaySnapshot(
  60_000,
  async (): Promise<SpotInsight & { readonly ticker: readonly InsightRow[] }> => {
    const view = await spotMarketView();
    const seen = new Set<string>();
    const priced = view.tokens.flatMap((token): InsightRow[] => {
      const metrics = token.metrics;
      // Tokens with one CoinGecko ID are the same asset on different chains or bridges: list it once.
      if (!metrics || !token.price || seen.has(metrics.coinId)) {
        return [];
      }
      seen.add(metrics.coinId);
      return [
        {
          key: token.assetId,
          symbol: token.assetId === WALLET_SWAP_INPUT ? "wNEAR" : token.tokenSymbol,
          icon: metrics.icon,
          price: token.price,
          volume24h: metrics.volume24h,
          marketCap: metrics.marketCap,
          verdict: null,
          change24h: metrics.change["24h"],
        },
      ];
    });
    const movers = priced.filter(
      (row) => row.change24h !== null && numeric(row.volume24h) >= MIN_MOVER_VOLUME_USD,
    );
    return {
      gainers: movers
        .filter((row) => numeric(row.change24h) > 0)
        .sort((a, b) => numeric(b.change24h) - numeric(a.change24h))
        .slice(0, INSIGHT_ROWS),
      losers: movers
        .filter((row) => numeric(row.change24h) < 0)
        .sort((a, b) => numeric(a.change24h) - numeric(b.change24h))
        .slice(0, INSIGHT_ROWS),
      // The most traded coins, whichever way they moved.
      ticker: [...priced].sort((a, b) => numeric(b.volume24h) - numeric(a.volume24h)).slice(0, TICKER_ROWS),
    };
  },
);

async function spotInsight(): Promise<SpotInsight> {
  const { gainers, losers } = await spotSnapshot();
  return { gainers, losers };
}

const perpsInsight = displaySnapshot(15_000, async (): Promise<ListInsight> => {
  const markets = await perpsMarketRows();
  return {
    rows: [...markets]
      .sort((a, b) => numeric(b.volume24h) - numeric(a.volume24h))
      .slice(0, INSIGHT_ROWS)
      .map((market) => ({
        key: market.name,
        symbol: market.name,
        icon: perpsIcon(market.name),
        price: market.mark,
        volume24h: market.volume24h,
        marketCap: null,
        verdict: null,
        change24h: market.change24h,
      })),
  };
});

const memecoinInsight = displaySnapshot(60_000, async (): Promise<ListInsight> => {
  const view = await memecoinView("volume");
  return {
    rows: view.coins.slice(0, INSIGHT_ROWS).map((coin) => ({
      key: coin.token,
      symbol: coin.symbol,
      icon: coin.icon,
      price: null,
      volume24h: coin.volume24h,
      marketCap: coin.marketCap,
      verdict: coin.verdict,
      change24h: coin.change24h,
    })),
  };
});

async function tickerInsight(): Promise<TickerInsight> {
  return { rows: [...(await spotSnapshot()).ticker] };
}

export async function marketInsight(card: InsightCard): Promise<SpotInsight | ListInsight | TickerInsight> {
  switch (card) {
    case "spot":
      return spotInsight();
    case "perps":
      return perpsInsight();
    case "memecoins":
      return memecoinInsight();
    case "ticker":
      return tickerInsight();
    default: {
      const unhandled: never = card;
      throw new Error(`Unhandled insight card: ${String(unhandled)}`);
    }
  }
}
