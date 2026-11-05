import { Plus } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { AgentsInfo } from "@/components/agents/agents-info";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { Badge } from "@/components/ui/badge";
import { ANY_AGENT_TYPE } from "@/shared/agent-create-request";

interface AgentCounts {
  /** Agents whose status is Running. */
  readonly live: number;
  readonly total: number;
}

/** How many agents are live, under the page title. A placeholder of the same height while the page loads. */
function LiveCount({ counts }: { readonly counts: AgentCounts | null }): ReactElement {
  if (counts === null) {
    return (
      <span
        aria-hidden="true"
        className="block h-6 w-40 rounded-full bg-surface-2 motion-safe:animate-pulse"
      />
    );
  }
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

/** The Agents page title, live count and actions. Without counts (the loading screen) the count is a placeholder. */
export function AgentsHeader({ counts = null }: { readonly counts?: AgentCounts | null }): ReactElement {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-page-title">Agents</h1>
        <LiveCount counts={counts} />
      </div>
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
