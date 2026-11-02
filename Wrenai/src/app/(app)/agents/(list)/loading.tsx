import type { ReactElement } from "react";
import { activeAgentToolSchema } from "@/shared/agent-scope";

// Same anatomy as page.tsx, AgentCard and AgentCatalog, so nothing shifts when the data arrives. It lives in the
// (list) group so agent detail, edit and new pages don't flash this list layout while they load.
const CARD = "flex min-w-0 flex-col card-shine rounded-lg p-4";
const BLOCK = "rounded-xs bg-surface-2 motion-safe:animate-pulse";
const GRID = "grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3";
const AGENT_SLOTS = ["first", "second"] as const;

function AgentCardSkeleton(): ReactElement {
  return (
    <div className={`${CARD} gap-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`${BLOCK} size-7 rounded-full`} />
          <div className="flex flex-col gap-1.5">
            <div className={`${BLOCK} h-4 w-32`} />
            <div className={`${BLOCK} h-3 w-24`} />
          </div>
        </div>
        <div className={`${BLOCK} h-6 w-18 rounded-full`} />
      </div>
      <div className="flex min-h-10 flex-col gap-2">
        <div className={`${BLOCK} h-3.5 w-full`} />
        <div className={`${BLOCK} h-3.5 w-3/4`} />
      </div>
      <div className="grid grid-cols-2 gap-4 rounded-lg-inset bg-sunken p-3 ring-1 ring-line-card ring-inset">
        <div className="flex flex-col gap-2">
          <div className={`${BLOCK} h-3 w-20`} />
          <div className={`${BLOCK} h-6 w-16`} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className={`${BLOCK} h-3 w-24`} />
          <div className={`${BLOCK} h-6 w-8`} />
        </div>
      </div>
      <div className="mt-auto flex items-end justify-between gap-3">
        <div className={`${BLOCK} h-3 w-40`} />
        <div className={`${BLOCK} h-8 w-16 rounded-sm`} />
      </div>
    </div>
  );
}

function CatalogCardSkeleton(): ReactElement {
  return (
    <div className={`${CARD} gap-3`}>
      <div className="flex items-center gap-2.5">
        <div className={`${BLOCK} size-5 rounded-full`} />
        <div className={`${BLOCK} h-4 w-36`} />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <div className={`${BLOCK} h-3.5 w-full`} />
        <div className={`${BLOCK} h-3.5 w-2/3`} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className={`${BLOCK} h-8 w-30 rounded-sm`} />
        <div className={`${BLOCK} h-8 w-22 rounded-sm`} />
      </div>
    </div>
  );
}

interface SectionSkeletonProps {
  readonly titleWidth: string;
  readonly aside: ReactElement;
  readonly children: ReactElement;
}

function SectionSkeleton({ titleWidth, aside, children }: SectionSkeletonProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <div className={`${BLOCK} h-6 ${titleWidth}`} />
        {aside}
      </div>
      {children}
    </div>
  );
}

export default function AgentsLoading(): ReactElement {
  return (
    <div role="status" aria-label="Loading agents" className="flex min-w-0 flex-col gap-12">
      <div aria-hidden="true" className="flex flex-wrap items-center justify-between gap-4">
        <div className={`${BLOCK} h-8 w-28`} />
        <div className="flex items-center gap-3">
          <div className={`${BLOCK} size-8 rounded-full`} />
          <div className={`${BLOCK} size-8 rounded-full`} />
          <div className={`${BLOCK} h-9 w-28 rounded-sm`} />
        </div>
      </div>
      <div aria-hidden="true" className="contents">
        <SectionSkeleton
          titleWidth="w-32"
          aside={
            <div className="flex items-center gap-4">
              <div className={`${BLOCK} h-3 w-20`} />
              <div className={`${BLOCK} h-8 w-24 rounded-sm`} />
            </div>
          }
        >
          <div className={GRID}>
            {AGENT_SLOTS.map((slot) => (
              <AgentCardSkeleton key={slot} />
            ))}
          </div>
        </SectionSkeleton>
        <SectionSkeleton titleWidth="w-40" aside={<div className={`${BLOCK} h-3 w-44`} />}>
          <div className={GRID}>
            {activeAgentToolSchema.options.map((tool) => (
              <CatalogCardSkeleton key={tool} />
            ))}
          </div>
        </SectionSkeleton>
      </div>
      <span className="sr-only">Loading agents…</span>
    </div>
  );
}
