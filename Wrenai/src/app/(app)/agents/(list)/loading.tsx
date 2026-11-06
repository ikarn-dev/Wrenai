import type { ReactElement } from "react";
import { AgentListSkeleton } from "@/components/agents/agent-list-skeleton";
import { AgentsHeader, LIVE_COUNT_PLACEHOLDER } from "@/components/agents/agents-header";
import { AgentCatalog } from "@/components/agents/catalog";
import { PortfolioSection } from "@/components/portfolio/panel";

// The header, section titles and the agent catalog need no data, so they render for real here. Only the live
// count (in the "Your agents" row) and the agent list are placeholders, the list in the "No agents yet" card's
// exact box. This lives in the (list) group so agent detail, edit and new pages don't flash this layout while they
// load.
export default function AgentsLoading(): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader />
      <PortfolioSection id="your-agents" title="Your agents" aside={LIVE_COUNT_PLACEHOLDER}>
        <AgentListSkeleton />
      </PortfolioSection>
      <AgentCatalog />
    </div>
  );
}
