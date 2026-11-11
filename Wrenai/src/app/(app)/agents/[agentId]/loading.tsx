import type { ReactElement } from "react";
import { RuntimeSkeleton, StrategySkeleton } from "@/components/agents/agent-page-sections";
import { PortfolioPanel } from "@/components/portfolio/panel";

const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";

// The agent page's own shell, in its real layout: Open navigates at once and the page fills in place, instead of
// holding the previous screen until the server answers. Next also prefetches this shell for every agent link in
// view, so it shows without a round trip.
export default function AgentLoading(): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <span aria-hidden="true" className={`${BLOCK} h-5 w-24`} />
      <header className="flex items-center gap-3">
        <span aria-hidden="true" className={`${BLOCK} size-9 rounded-full`} />
        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className={`${BLOCK} h-8 w-56`} />
          <span aria-hidden="true" className={`${BLOCK} h-6 w-24 rounded-full`} />
        </div>
      </header>
      <RuntimeSkeleton />
      <div className="grid min-w-0 gap-stack xl:grid-cols-2">
        <PortfolioPanel id="strategy-loading" title="What it does">
          <StrategySkeleton />
        </PortfolioPanel>
        <PortfolioPanel id="limits-loading" title="Limits">
          <StrategySkeleton />
        </PortfolioPanel>
      </div>
    </div>
  );
}
