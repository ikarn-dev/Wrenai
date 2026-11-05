import type { ReactElement } from "react";
import { AgentsHeader, EMPTY_AGENTS_CARD } from "@/components/agents/agents-header";
import { AgentCatalog } from "@/components/agents/catalog";
import { PortfolioSection } from "@/components/portfolio/panel";

// The header, section titles and the agent catalog need no data, so they render for real here. Only the live
// count (inside the header) and the agent list are placeholders, the list in the "No agents yet" card's exact box. Placeholder lines
// use h-lh with the real text style, so each is exactly one line of that text tall. This lives in the (list)
// group so agent detail, edit and new pages don't flash this layout while they load.
const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";

export default function AgentsLoading(): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader />
      <div role="status" aria-label="Loading your agents">
        <PortfolioSection id="your-agents" title="Your agents">
          <div aria-hidden="true" className={EMPTY_AGENTS_CARD}>
            <span className={`${BLOCK} size-5 rounded-full`} />
            <span className={`${BLOCK} h-lh w-28 text-body`} />
            <span className={`${BLOCK} h-lh w-52 text-small`} />
          </div>
        </PortfolioSection>
      </div>
      <AgentCatalog />
    </div>
  );
}
