"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Change } from "@/components/trading/market-cells";
import { TokenIcon } from "@/components/trading/token-icon";
import { readTrading } from "@/components/trading/trading-api";
import { type InsightRow, tickerInsightSchema } from "@/shared/portfolio-insights";
import { decimalDisplay } from "@/shared/trading-display";

// The top of Portfolio → Insights: the most traded spot coins across every chain NEAR Intents routes to, scrolling
// in one line, each with its price and 24 h change. It shares the movers card's one-minute spot snapshot, loads
// after the page paints and keeps one fixed height in every state, so nothing below it moves. It holds still while
// hovered or focused; under reduced motion it never moves and scrolls sideways by hand (styles/ticker.css).
const FRESH_MS = 60_000;
const STRIP = "flex h-12 min-w-0 items-center card-shine rounded-lg px-4";
const PLACEHOLDER_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

function TickerItem({ row }: { readonly row: InsightRow }): ReactElement {
  return (
    <li className="flex shrink-0 items-center gap-2 text-small whitespace-nowrap">
      <TokenIcon symbol={row.symbol} icon={row.icon} size={20} />
      <span className="font-medium text-fg-strong">{row.symbol}</span>
      <span className="font-mono tabular-nums text-fg-muted">
        {row.price ? `$${decimalDisplay(row.price)}` : "—"}
      </span>
      <span className="font-mono tabular-nums">
        <Change value={row.change24h} />
      </span>
    </li>
  );
}

/** The ticker's loading strip, also used by the Portfolio route's loading screen. */
export function MarketTickerSkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading market ticker" className={STRIP}>
      <div className="flex min-w-0 flex-1 gap-6 overflow-hidden">
        {PLACEHOLDER_KEYS.map((key) => (
          <span
            key={key}
            aria-hidden="true"
            className="block h-lh w-32 shrink-0 rounded-xs bg-surface-2 text-small motion-safe:animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

export function MarketTicker(): ReactElement {
  const query = useQuery({
    queryKey: ["portfolio-insight", "ticker"],
    queryFn: ({ signal }) => readTrading("/api/portfolio/insights?card=ticker", tickerInsightSchema, signal),
    staleTime: FRESH_MS,
    refetchInterval: FRESH_MS,
    retry: 1,
  });
  const rows = query.data?.rows;

  if (rows === undefined && !query.isError) {
    return <MarketTickerSkeleton />;
  }
  if (rows === undefined || rows.length === 0) {
    return (
      <div className={STRIP}>
        <p className="truncate text-small text-fg-muted">
          {query.isError ? "Market data is unavailable. Refresh to retry." : "No spot markets right now."}
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Most traded spot coins, 24 hours" className={STRIP}>
      <div className="ticker min-w-0 flex-1">
        <div className="ticker-track">
          <ul className="ticker-list">
            {rows.map((row) => (
              <TickerItem key={row.key} row={row} />
            ))}
          </ul>
          {/* The second copy completes the loop; screen readers get the list once. */}
          <ul aria-hidden="true" className="ticker-list">
            {rows.map((row) => (
              <TickerItem key={row.key} row={row} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
