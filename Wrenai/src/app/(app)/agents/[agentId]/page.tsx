import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AgentAvatar } from "@/components/agents/avatar";
import { AgentRuntimePanel } from "@/components/agents/runtime-status";
import { PolicySummary, StrategySummary } from "@/components/agents/strategy-summary";
import { AgentTradePreview } from "@/components/agents/trade-preview";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { Badge } from "@/components/ui/badge";
import { AgentError } from "@/server/agents/errors";
import { readAgent } from "@/server/agents/mutations";
import { agentHistory } from "@/server/agents/queries";
import { deployedRuntimeReady, EXECUTION_UNAVAILABLE } from "@/server/agents/readiness";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { agentRuntimeStatus } from "@/server/engine/status";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { type AgentSummary, PACKS } from "@/shared/agents";

function timestamp(value: number): string {
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

export const maxDuration = 120;

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
  const [history, runtime, venueAccount] = await Promise.all([
    agentHistory(user.id, agent.id),
    agentRuntimeStatus(database(), user.id, agent.id),
    agent.pack === "perps" ? readAgentTradingAccount(database(), user.id, agent.id) : Promise.resolve(null),
  ]);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link
        href="/agents"
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        All agents
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <AgentAvatar running={agent.status === "running"} />
          <div className="flex flex-col gap-2">
            <h1 className="text-h1">{agent.name}</h1>
            <p className="text-small text-fg-muted">
              {PACKS[agent.pack].label} · Strategy v{agent.version}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Badge tone="neutral">Verified AI</Badge>
        </div>
      </header>
      {agent.pack === "meme_hunter" ? (
        <p className="rounded-sm border border-line bg-surface-2 p-3 text-small text-fg-muted">
          {EXECUTION_UNAVAILABLE}
        </p>
      ) : null}
      {agent.pack === "perps" ? (
        <PortfolioPanel id="perps-account" title="Perps trading account">
          <p className="text-small text-fg-muted">
            Starting converts this agent’s allocated private tokens into USDC at its separate Hyperliquid
            address. Venue balances, orders and fills are public. Vercel controls the trading key; the updated
            encrypted recovery backup is required before funding.
          </p>
          {venueAccount ? (
            <p className="mt-3 break-all font-mono text-small tabular-nums">{venueAccount.perpAddress}</p>
          ) : (
            <Link
              href="/settings"
              className="mt-3 inline-flex min-h-11 items-center text-small text-accent-text underline underline-offset-4"
            >
              Save recovery backup in Settings
            </Link>
          )}
          <p className="mt-2 text-caption text-fg-subtle">
            Native TP/SL orders use explicit limit prices and can remain unfilled during gaps. Trailing
            updates use five-second checks; pause or revocation stops new updates and leaves existing native
            orders in place.
          </p>
        </PortfolioPanel>
      ) : null}
      {agent.pack === "triggers" ? (
        <p className="text-small text-fg-muted">
          Triggers use a Coinbase USD reference and private 1Click execution. Checks are best effort; stops
          can miss moves during worker or provider outages.
        </p>
      ) : null}
      {agent.pack === "copy_trading" ? (
        <p className="text-small text-fg-muted">
          Copies supported public NEAR-origin 1Click swaps at best-effort one-minute checks. Private,
          unrelated, stale and unexecutable activity is skipped. This is not a complete wallet-history feed.
        </p>
      ) : null}
      <AgentRuntimePanel
        agent={agent}
        ownerId={user.id}
        initial={runtime}
        executionAvailable={
          agent.pack !== "meme_hunter" && deployedRuntimeReady(agent.pack !== "whale_tracker")
        }
      />
      {agent.pack !== "whale_tracker" ? (
        <AgentTradePreview key={`${agent.id}:${agent.revision}`} agent={agent} accountId={user.accountId} />
      ) : null}
      <div className="grid min-w-0 items-start gap-stack xl:grid-cols-2">
        <PortfolioPanel id="strategy" title="Your strategy">
          <p className="whitespace-pre-wrap text-body leading-relaxed text-fg">{agent.strategyText}</p>
          <StrategySummary strategy={agent.strategy} />
        </PortfolioPanel>
        <PortfolioPanel id="limits" title="Trading limits">
          <PolicySummary policy={agent.policy} />
        </PortfolioPanel>
      </div>
      <div className="grid min-w-0 gap-stack xl:grid-cols-2">
        <PortfolioPanel id="versions" title="Strategy versions">
          <ol className="flex flex-col gap-5">
            {history.versions.map((version) => (
              <li key={version.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-small font-medium">Version {version.version}</h3>
                  <time
                    dateTime={new Date(version.createdAt).toISOString()}
                    className="font-mono text-caption text-fg-subtle"
                  >
                    {timestamp(version.createdAt)} UTC
                  </time>
                </div>
                <p className="text-small leading-relaxed text-fg-muted">{version.strategyText}</p>
                <p className="text-caption text-fg-subtle">
                  Model verified · {version.model} · {timestamp(version.verifiedAt)} UTC
                </p>
              </li>
            ))}
          </ol>
        </PortfolioPanel>
        <PortfolioPanel id="history" title="Agent history">
          <ol className="flex flex-col gap-5">
            {history.events.map((event) => (
              <li key={event.id} className="flex flex-col gap-1">
                <p className="text-small text-fg">{event.message}</p>
                <time
                  dateTime={new Date(event.createdAt).toISOString()}
                  className="font-mono text-caption text-fg-subtle"
                >
                  {timestamp(event.createdAt)} UTC
                </time>
              </li>
            ))}
          </ol>
        </PortfolioPanel>
      </div>
    </div>
  );
}
