import { Plus, Waypoints } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentsInfo } from "@/components/agents/agents-info";
import { AgentCatalog } from "@/components/agents/catalog";
import { GlobalStop } from "@/components/agents/controls";
import { SetupCard } from "@/components/agents/setup-card";
import { PortfolioSection } from "@/components/portfolio/panel";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { listAgents, readTradingControls } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { listAgentSetups } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";

export const metadata: Metadata = { title: "Agents" };

// Same anatomy as Portfolio: a page title with its actions, then titled sections of cards.
export default async function AgentsPage() {
  const user = await requireUser();
  const [controls, setups, agents] = await Promise.all([
    readTradingControls(database(), user.id),
    listAgentSetups(database(), user.id),
    listAgents(database(), user.id),
  ]);
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-page-title">Agents</h1>
        <div className="flex items-center gap-3">
          <AgentsInfo />
          <RefreshPortfolioButton />
          <Link
            href="/agents/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-sm bg-accent px-3.5 text-small font-medium text-accent-fg transition-[background-color,scale] duration-200 ease-ios hover:bg-accent-text active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
          >
            <Plus size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden="true" />
            New agent
          </Link>
        </div>
      </header>
      <PortfolioSection
        id="your-agents"
        title="Your agents"
        aside={
          <div className="flex items-center gap-4">
            <p className="text-caption text-fg-subtle">
              <span className="font-mono text-fg-strong">{running}</span> of{" "}
              <span className="font-mono text-fg-strong">{agents.length}</span> running
            </p>
            {/* The kill switch (Spec §5 rule 2): shown whenever there is something to stop or it is already on. */}
            {agents.length > 0 || controls.engaged ? (
              <GlobalStop engaged={controls.engaged} revision={controls.revision} />
            ) : null}
          </div>
        }
      >
        {agents.length === 0 ? (
          <div className="relative flex flex-col items-center gap-3 overflow-hidden card-shine rounded-lg px-6 py-10 text-center">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
            <Waypoints
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
    </div>
  );
}
