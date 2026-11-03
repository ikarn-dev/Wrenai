import { ChartNoAxesCombined, History, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import { formatCompactMicroUsd } from "@/shared/money";
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
      <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-sm bg-sunken ring-1 ring-line-card ring-inset">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
        <p className="relative flex items-center gap-2 px-4 text-small text-fg-muted">
          <Icon aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
          {empty}
        </p>
      </div>
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
        footer="Realized PnL; unknown costs are never treated as zero"
      />
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
