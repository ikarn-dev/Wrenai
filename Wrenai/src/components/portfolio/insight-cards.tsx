import { ChartNoAxesCombined, ChartPie, History, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { PortfolioPanel } from "./panel";

interface InsightCardProps {
  readonly id: string;
  readonly title: string;
  /** The figure the card will show once measured; until then a dash. */
  readonly figure: string;
  readonly icon: LucideIcon;
  readonly empty: string;
  readonly footer: string;
}

// Same anatomy as a chart card: eyebrow, the figure, a chart well, a footer line. No data is drawn until it is
// recorded, so the well holds a dot grid and one line on what fills it.
function InsightCard({ id, title, figure, icon: Icon, empty, footer }: InsightCardProps): ReactElement {
  return (
    <PortfolioPanel id={id} title={title}>
      <dl>
        <dt className="sr-only">{figure}</dt>
        <dd className="font-mono text-num-lg text-fg-muted">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Unavailable</span>
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

export function InsightCards(): ReactElement {
  return (
    <div className="grid gap-stack md:grid-cols-3">
      <InsightCard
        id="performance"
        title="Performance"
        figure="Total PnL"
        icon={ChartNoAxesCombined}
        empty="No recorded trades yet"
        footer="PnL after fees, from recorded fills"
      />
      <InsightCard
        id="allocation"
        title="Allocation"
        figure="Largest holding"
        icon={ChartPie}
        empty="Needs balances in every location"
        footer="Wallet, Intents and confidential balances"
      />
      <InsightCard
        id="recent-activity"
        title="Recent activity"
        figure="Actions today"
        icon={History}
        empty="Transfers and fills appear here"
        footer="Newest first, across all agents"
      />
    </div>
  );
}
