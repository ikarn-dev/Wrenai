import { BrainCircuit, ChartNoAxesCombined, MessageCircle, ShieldCheck, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import { ActivitySkeleton } from "@/components/activity/skeleton";
import { TradingAccessSkeleton } from "@/components/portfolio/access-card";
import { MarketInsightsSkeleton } from "@/components/portfolio/market-insights";
import { MarketTickerSkeleton } from "@/components/portfolio/market-ticker";
import { PortfolioSection, StatTile } from "@/components/portfolio/panel";
import { WalletValueSkeleton } from "@/components/portfolio/wallet-cards";

// The same components and grid as page.tsx with line-tall placeholders (`h-lh` in each value's own text style), so
// nothing shifts when the real page replaces this one.
const PANEL = "min-w-0 card-shine rounded-lg p-card";
const BLOCK = "rounded-xs bg-surface-2 motion-safe:animate-pulse";
const LINE = `block h-lh ${BLOCK}`;
const TILES = [
  { label: "Agents", icon: BrainCircuit },
  { label: "Realized PnL", icon: ChartNoAxesCombined },
  { label: "Budgets", icon: ShieldCheck },
  { label: "Telegram", icon: MessageCircle },
] as const;

function SectionSkeleton({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div className={`${BLOCK} h-6 w-28`} />
      {children}
    </div>
  );
}

export default function PortfolioLoading(): ReactElement {
  return (
    <div aria-busy="true" className="flex flex-col gap-12">
      <span role="status" className="sr-only">
        Loading portfolio
      </span>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <h1 className="font-display text-page-title">Portfolio</h1>
        <div
          aria-hidden="true"
          className="size-8 rounded-full bg-surface-2 motion-safe:animate-pulse pointer-coarse:size-11"
        />
      </header>
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-12">
        <div className="grid min-w-0 gap-stack lg:grid-cols-2">
          <div className="grid gap-stack sm:grid-cols-2">
            <div className="grid sm:col-span-2">
              <StatTile icon={Wallet} label="NEAR wallet">
                <WalletValueSkeleton />
              </StatTile>
            </div>
            {TILES.map((tile) => (
              <StatTile key={tile.label} icon={tile.icon} label={tile.label}>
                <span className={`${LINE} w-24`} />
              </StatTile>
            ))}
          </div>
          <TradingAccessSkeleton />
        </div>
        {/* The real section title and card shells: they need no data. */}
        <PortfolioSection id="insights-loading" title="Insights">
          <div className="flex min-w-0 flex-col gap-stack">
            <MarketTickerSkeleton />
            <MarketInsightsSkeleton />
          </div>
        </PortfolioSection>
        <SectionSkeleton>
          <div className="grid gap-stack xl:grid-cols-3">
            <div className={`${PANEL} min-h-72 xl:col-span-2`} />
            <div className={`${PANEL} min-h-72`} />
          </div>
        </SectionSkeleton>
        <SectionSkeleton>
          <ActivitySkeleton />
        </SectionSkeleton>
      </div>
    </div>
  );
}
