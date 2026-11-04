import { ChartNoAxesCombined, History, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import { formatCompactMicroUsd } from "@/shared/money";
import { maximumUnits } from "@/shared/token-units";
import { PortfolioPanel } from "./panel";

interface InsightCardProps {
  readonly id: string;
  readonly title: string;
  /** The figure the card will show once measured; until then a dash. */
  readonly figure: string;
  readonly icon: LucideIcon;
  readonly empty: string;
  readonly footer: string;
  readonly value?: string | undefined;
  readonly children?: ReactNode;
}

// Same anatomy as a chart card: eyebrow, the figure, a chart well, a footer line. No data is drawn until it is
// recorded, so the well holds a dot grid and one line on what fills it.
function InsightCard({
  id,
  title,
  figure,
  icon: Icon,
  empty,
  footer,
  value,
  children,
}: InsightCardProps): ReactElement {
  return (
    <PortfolioPanel id={id} title={title}>
      <dl>
        <dt className="sr-only">{figure}</dt>
        <dd className="font-mono text-num-lg text-fg-muted">
          {value ?? (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">Unavailable</span>
            </>
          )}
        </dd>
      </dl>
      {children ?? (
        <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-sm bg-sunken ring-1 ring-line-card ring-inset">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
          <p className="relative flex items-center gap-2 px-4 text-small text-fg-muted">
            <Icon aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
            {empty}
          </p>
        </div>
      )}
      <p className="text-caption text-fg-subtle">{footer}</p>
    </PortfolioPanel>
  );
}

export function InsightCards({
  performance,
  allocation,
}: {
  readonly performance: PortfolioPerformance;
  readonly allocation: ReactNode;
}): ReactElement {
  return (
    <div className="grid gap-stack md:grid-cols-3">
      <InsightCard
        id="performance"
        title="Performance"
        figure="Total PnL"
        icon={ChartNoAxesCombined}
        value={
          performance.totalMicroUsd === null ? undefined : formatCompactMicroUsd(performance.totalMicroUsd)
        }
        empty={
          performance.count
            ? performance.unpriced
              ? "Some cost or fee data is missing"
              : "Realized performance from settled fills"
            : "No recorded fills"
        }
        footer="Settled cash PnL; transfers are excluded and unknown costs stay unknown"
      >
        {performance.days.length ? <DailyPerformance days={performance.days} /> : null}
      </InsightCard>
      {allocation}
      <InsightCard
        id="recent-activity"
        title="Recent activity"
        figure="Days with recorded fills this month"
        icon={History}
        value={String(performance.days.length)}
        empty="Full wallet and agent activity below"
        footer="Calendar uses recorded UTC dates"
      />
    </div>
  );
}

function DailyPerformance({ days }: { readonly days: PortfolioPerformance["days"] }): ReactElement {
  const values = days.flatMap((day) =>
    day.pnlMicroUsd === null ? [] : [day.pnlMicroUsd < 0n ? -day.pnlMicroUsd : day.pnlMicroUsd],
  );
  const maximum = values.reduce(maximumUnits, 1n);
  return (
    <svg
      viewBox="0 0 320 100"
      role="img"
      aria-label="Daily settled trading PnL this month. Unknown values are marked separately."
      className="h-32 w-full"
    >
      <line x1={0} x2={320} y1={50} y2={50} className="stroke-line" />
      {days.map((day, index) => {
        const x = 5 + (index * 310) / days.length,
          width = Math.max(2, 300 / days.length - 3),
          pnl = day.pnlMicroUsd,
          magnitude = pnl === null ? 0n : pnl < 0n ? -pnl : pnl,
          height = pnl === null ? 3 : Math.max(1, Number((magnitude * 40n) / maximum));
        return (
          <rect
            key={day.date}
            x={x}
            width={width}
            y={pnl !== null && pnl > 0n ? 50 - height : 50}
            height={height}
            className={pnl === null ? "fill-fg-subtle" : pnl < 0n ? "fill-loss" : "fill-accent"}
          >
            <title>
              {day.date} · {pnl === null ? "Unknown" : formatCompactMicroUsd(pnl)}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
