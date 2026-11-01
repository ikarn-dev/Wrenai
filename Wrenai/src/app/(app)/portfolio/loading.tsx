import type { ReactElement } from "react";

// Same grid as page.tsx, so nothing shifts when the data arrives.
const PANEL = "min-w-0 card-shine rounded-lg p-card";
const BLOCK = "rounded-xs bg-surface-2 motion-safe:animate-pulse";
const TILES = ["wallet", "access", "public", "confidential", "agents", "pnl"] as const;
const INSIGHTS = ["performance", "allocation", "activity"] as const;

function TileSkeleton(): ReactElement {
  return (
    <div className={`${PANEL} flex min-h-32 flex-col gap-3 p-4`}>
      <div className={`${BLOCK} h-3 w-20`} />
      <div className={`${BLOCK} h-5 w-28`} />
      <div className={`${BLOCK} mt-auto h-3 w-24`} />
    </div>
  );
}

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
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-h1">Portfolio</h1>
          <p className="text-small text-fg-muted">Balances, agents and trading access</p>
        </div>
        <div aria-hidden="true" className={`${BLOCK} h-10 w-32 pointer-coarse:h-11`} />
      </header>
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-12">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="grid gap-stack sm:grid-cols-2">
            {TILES.map((id) => (
              <TileSkeleton key={id} />
            ))}
          </div>
          <div className={`${PANEL} min-h-72`} />
        </div>
        <SectionSkeleton>
          <div className="grid gap-stack md:grid-cols-3">
            {INSIGHTS.map((id) => (
              <div key={id} className={`${PANEL} flex flex-col gap-4`}>
                <div className={`${BLOCK} h-4 w-24`} />
                <div className={`${BLOCK} h-6 w-16`} />
                <div className={`${BLOCK} h-32 w-full`} />
              </div>
            ))}
          </div>
        </SectionSkeleton>
        <SectionSkeleton>
          <div className="grid gap-stack xl:grid-cols-3">
            <div className={`${PANEL} min-h-72 xl:col-span-2`} />
            <div className={`${PANEL} min-h-72`} />
          </div>
        </SectionSkeleton>
      </div>
    </div>
  );
}
