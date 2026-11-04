"use client";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useId } from "react";
import { getMarketChart } from "@/server/manual-trading/actions";
import { maximumUnits, minimumUnits } from "@/shared/token-units";
import { decimalDisplay } from "@/shared/trading-display";

export function MarketChart({ market }: { readonly market: string }): ReactElement {
  const label = useId(),
    query = useQuery({
      queryKey: ["market-chart", market],
      queryFn: async () => {
        const r = await getMarketChart(market);
        if (!r.ok) {
          throw new Error(r.message);
        }
        return r.value;
      },
      staleTime: 60000,
      refetchInterval: 60000,
      retry: false,
    });
  const bars = query.data?.bars ?? [],
    values = bars.map((b) => {
      const [whole = "0", frac = ""] = b.close.split(".");
      return BigInt(whole) * 10n ** 36n + BigInt(frac.padEnd(36, "0"));
    });
  const low = values.reduce(minimumUnits, values[0] ?? 0n),
    high = values.reduce(maximumUnits, values[0] ?? 0n),
    range = high - low;
  const points = values
    .map(
      (value, index) =>
        `${10 + Math.round((index * 620) / Math.max(1, values.length - 1))},${range === 0n ? 100 : 180 - Number(((value - low) * 160n) / range)}`,
    )
    .join(" ");
  return (
    <div className="mt-5 min-w-0">
      <div className="flex aspect-video max-h-72 items-center justify-center rounded-sm bg-sunken">
        {query.isPending ? (
          <p role="status" className="text-small text-fg-muted">
            Loading hourly chart…
          </p>
        ) : query.error ? (
          <p role="alert" className="p-5 text-small text-fg-muted">
            Chart unavailable. Live order quotes are checked separately.
          </p>
        ) : (
          <svg
            viewBox="0 0 640 200"
            role="img"
            aria-labelledby={label}
            className="h-full w-full text-accent-text"
          >
            <title id={label}>{market} · hourly closing prices for the last four days</title>
            <line x1="10" x2="630" y1="180" y2="180" stroke="currentColor" strokeOpacity="0.12" />
            <polyline
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      {query.data ? (
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {query.data.indicators.map((i) => (
            <div key={i.label}>
              <dt className="text-caption text-fg-muted">{i.label} · 1h</dt>
              <dd className="mt-1 font-mono text-small tabular-nums text-fg-strong">
                {decimalDisplay(i.value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
