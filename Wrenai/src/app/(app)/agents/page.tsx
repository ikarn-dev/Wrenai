import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentCatalog } from "@/components/agents/catalog";
import { GlobalStop } from "@/components/agents/controls";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { EXECUTION_UNAVAILABLE } from "@/server/agents/readiness";
import { listAgents, readTradingControls } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { listAgentSetups } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";
import { AGENT_CATALOG } from "@/shared/agent-catalog";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage() {
  const user = await requireUser();
  const controls = await readTradingControls(database(), user.id);
  const setups = await listAgentSetups(database(), user.id);
  const agents = await listAgents(database(), user.id);
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-h1">Agents</h1>
          <p className="text-body text-fg-muted">Your strategies. Your limits.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RefreshPortfolioButton />
          <Link
            href="/agents/new"
            className="inline-flex h-10 items-center gap-2 rounded-sm bg-accent px-4 text-body font-medium text-accent-fg hover:bg-accent-hover"
          >
            <Plus aria-hidden="true" size={16} />
            New agent
          </Link>
        </div>
      </header>
      <p className="rounded-sm border border-line bg-surface-2 p-3 text-small text-fg-muted">
        {EXECUTION_UNAVAILABLE}
      </p>
      <section aria-label="Agent overview" className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-small text-fg-muted">
          <span className="font-mono text-fg-strong tabular-nums">{agents.length}</span>{" "}
          {agents.length === 1 ? "agent" : "agents"}
          <span className="mx-3 text-fg-disabled">/</span>
          <span className="font-mono text-fg-strong tabular-nums">{running}</span> running
        </p>
        <GlobalStop engaged={controls.engaged} revision={controls.revision} />
      </section>
      {setups.length ? (
        <section aria-label="Saved setups" className="space-y-3">
          <h2 className="text-h3">Saved setups</h2>
          <p className="text-small text-fg-subtle">Planning drafts · not active agents</p>
          <div className="grid gap-3 md:grid-cols-2">
            {setups.map((setup) => (
              <Link
                key={setup.id}
                href={`/agents/setup/${setup.id}`}
                className="rounded-md border border-line p-4 hover:bg-surface-2"
              >
                <span className="text-small font-medium">{AGENT_CATALOG[setup.tool].name}</span>
                <p className="mt-2 line-clamp-2 text-small text-fg-muted">{setup.brief}</p>
                <p className="mt-2 text-caption text-fg-subtle">
                  {setup.reviewState === "reviewed" ? "Reviewed setup" : "Draft"} · execution unavailable
                </p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {agents.length === 0 ? (
        <p className="py-3 text-small text-fg-subtle">
          No saved agents yet. Choose a type below to create a setup.
        </p>
      ) : (
        <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
      <AgentCatalog />
    </div>
  );
}
