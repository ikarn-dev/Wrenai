import { BrainCircuit } from "lucide-react";
import type { Metadata } from "next";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentsHeader, EMPTY_AGENTS_CARD } from "@/components/agents/agents-header";
import { AgentCatalog } from "@/components/agents/catalog";
import { GlobalStop } from "@/components/agents/controls";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { SetupCard } from "@/components/agents/setup-card";
import { PortfolioSection } from "@/components/portfolio/panel";
import { type CreateAgentQuery, resolveCreateRequest } from "@/server/agents/create-request";
import { listAgents, readTradingControls } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { listAgentSetups } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";

export const metadata: Metadata = { title: "Agents" };
// The create dialog's strategy verification and save run as this page's Server Actions.
export const maxDuration = 120;

// Same anatomy as Portfolio: a page title with its actions, then titled sections of cards. `?create=` and
// `?setup=` open the create dialog over it.
export default async function AgentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<CreateAgentQuery>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const [controls, setups, agents, createRequest] = await Promise.all([
    readTradingControls(database(), user.id),
    listAgentSetups(database(), user.id),
    listAgents(database(), user.id),
    resolveCreateRequest(user.id, query),
  ]);
  const live = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader counts={{ live, total: agents.length }} />
      <PortfolioSection
        id="your-agents"
        title="Your agents"
        aside={
          // The kill switch (Spec §5 rule 2): shown whenever there is something to stop or it is already on.
          agents.length > 0 || controls.engaged ? (
            <GlobalStop engaged={controls.engaged} revision={controls.revision} />
          ) : null
        }
      >
        {agents.length === 0 ? (
          <div className={EMPTY_AGENTS_CARD}>
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
            <BrainCircuit
              size={20}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
              className="relative text-accent-text"
            />
            <p className="relative text-body text-fg-strong">No agents yet</p>
            <p className="relative text-small text-fg-muted">Pick a type below to set one up.</p>
          </div>
        ) : (
          <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </PortfolioSection>
      {setups.length ? (
        <PortfolioSection
          id="saved-setups"
          title="Saved setups"
          aside={<span className="text-caption text-fg-subtle">Drafts, not running</span>}
        >
          <div className="grid gap-stack md:grid-cols-2 2xl:grid-cols-3">
            {setups.map((setup) => (
              <SetupCard key={setup.id} setup={setup} />
            ))}
          </div>
        </PortfolioSection>
      ) : null}
      <AgentCatalog />
      <CreateAgentDialog request={createRequest} />
    </div>
  );
}
