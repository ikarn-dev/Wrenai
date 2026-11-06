import { Plus } from "lucide-react";
import Link from "next/link";
import { type ReactElement, Suspense } from "react";
import { AgentsInfo } from "@/components/agents/agents-info";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { Badge } from "@/components/ui/badge";
import { ANY_AGENT_TYPE } from "@/shared/agent-create-request";

interface AgentCounts {
  /** Agents whose status is Running. */
  readonly live: number;
  readonly total: number;
}

/** The live count's placeholder: the badge's own 24 px height, so the "Your agents" row never changes height. */
export const LIVE_COUNT_PLACEHOLDER = (
  <span aria-hidden="true" className="block h-6 w-36 rounded-full bg-surface-2 motion-safe:animate-pulse" />
);

async function LiveCountValue({ data }: { readonly data: Promise<AgentCounts> }): Promise<ReactElement> {
  const counts = await data;
  return (
    <p className="flex items-center gap-2 text-small text-fg-muted">
      <Badge tone={counts.live > 0 ? "accent" : "neutral"} dot>
        <span className="font-mono tabular-nums">{counts.live}</span> live
      </Badge>
      <span>
        of <span className="font-mono tabular-nums text-fg-strong">{counts.total}</span>{" "}
        {counts.total === 1 ? "agent" : "agents"}
      </span>
    </p>
  );
}

/** How many agents are live, for the "Your agents" row. Streams in behind a placeholder of the same height. */
export function LiveCount({ data }: { readonly data: Promise<AgentCounts> }): ReactElement {
  return (
    <Suspense fallback={LIVE_COUNT_PLACEHOLDER}>
      <LiveCountValue data={data} />
    </Suspense>
  );
}

/** The Agents page title and actions. Needs no data, so the loading screen renders the same header. */
export function AgentsHeader(): ReactElement {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="font-display text-page-title">Agents</h1>
      <div className="flex items-center gap-3">
        <AgentsInfo />
        <RefreshPortfolioButton />
        <Link
          href={`/agents?create=${ANY_AGENT_TYPE}`}
          scroll={false}
          className="inline-flex h-9 items-center gap-1.5 rounded-sm bg-accent px-3.5 text-small font-medium text-accent-fg transition-[background-color,scale] duration-200 ease-ios hover:bg-accent-text active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
        >
          <Plus size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden="true" />
          New agent
        </Link>
      </div>
    </header>
  );
}

/** The "No agents yet" card. The loading screen draws the same box, so the page doesn't shift. */
export const EMPTY_AGENTS_CARD =
  "relative flex flex-col items-center gap-3 overflow-hidden card-shine rounded-lg px-6 py-10 text-center";
