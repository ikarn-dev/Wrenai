import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { AgentAdvancedOptions } from "@/components/agents/advanced-options";
import { AgentTypeBadge } from "@/components/agents/agent-card";
import {
  HistorySection,
  PerpsSection,
  RuntimeSection,
  RuntimeSkeleton,
  StrategySection,
  StrategySkeleton,
} from "@/components/agents/agent-page-sections";
import { AgentAllocations } from "@/components/agents/allocations";
import { AgentAvatar } from "@/components/agents/avatar";
import { PolicySummary } from "@/components/agents/strategy-summary";
import { AgentTradePreview } from "@/components/agents/trade-preview";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { AgentError } from "@/server/agents/errors";
import { readAgent } from "@/server/agents/mutations";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { usesPublicRoute } from "@/shared/agent-instructions";
import { agentSetupProfile } from "@/shared/agent-templates";
import type { AgentSummary } from "@/shared/agents";

export const maxDuration = 120;

/**
 * The agent's header and limits render from one read; status, the strategy's token names, venue accounts and
 * history each stream in behind their own placeholder instead of holding the whole page.
 */
export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ readonly agentId: string }>;
}) {
  const user = await requireUser();
  const { agentId } = await params;
  if (!z.uuid().safeParse(agentId).success) {
    notFound();
  }
  let agent: AgentSummary;
  try {
    agent = await readAgent(database(), user.id, agentId);
  } catch (error) {
    if (error instanceof AgentError && error.code === "not_found") {
      notFound();
    }
    throw error;
  }
  const publicRhea = "format" in agent.strategy && usesPublicRoute(agent.strategy);
  const executionAvailable = deployedRuntimeReady(publicRhea);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link
        href="/agents"
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        All agents
      </Link>
      <header className="flex items-center gap-3">
        <AgentAvatar running={agent.status === "running"} size={36} />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <h1 className="max-w-full truncate text-h1">{agent.name}</h1>
          <AgentTypeBadge pack={agent.pack} />
        </div>
      </header>
      <Suspense fallback={<RuntimeSkeleton />}>
        <RuntimeSection agent={agent} ownerId={user.id} executionAvailable={executionAvailable} />
      </Suspense>
      {agent.pack === "meme_hunter" ? (
        <p className="rounded-sm border border-line bg-surface-2 p-3 text-small text-fg-muted">
          Scans new listings with{" "}
          <a
            href="https://nearsquint.tech"
            target="_blank"
            rel="noreferrer"
            className="text-accent-text underline underline-offset-4"
          >
            Squint
          </a>
          . It only buys tokens that pass every token, liquidity and route check, and a pass can’t guarantee a
          later sale.
        </p>
      ) : null}
      {agent.pack === "perps" ? (
        <Suspense fallback={null}>
          <PerpsSection agent={agent} user={user} />
        </Suspense>
      ) : null}
      {/* Funds are added during Deploy and returned to the wallet on Delete, so there is no funds step here.
          The two cards share one row height (the grid's default stretch), so their edges line up. */}
      <div className="grid min-w-0 gap-stack xl:grid-cols-2">
        <PortfolioPanel id="strategy" title="What it does">
          <Suspense fallback={<StrategySkeleton />}>
            <StrategySection agent={agent} ownerId={user.id} />
          </Suspense>
        </PortfolioPanel>
        <PortfolioPanel id="limits" title={agentSetupProfile(agent.pack).limits}>
          <PolicySummary pack={agent.pack} policy={agent.policy} />
        </PortfolioPanel>
      </div>
      <AgentAdvancedOptions>
        {!publicRhea ? (
          <AgentTradePreview key={`${agent.id}:${agent.revision}`} agent={agent} accountId={user.accountId} />
        ) : null}
        <AgentAllocations agentId={agent.id} ownerId={user.id} />
        <Suspense fallback={<StrategySkeleton />}>
          <HistorySection agentId={agent.id} ownerId={user.id} />
        </Suspense>
      </AgentAdvancedOptions>
    </div>
  );
}
