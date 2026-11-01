import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { type AgentSummary, PACKS, parseUsd } from "@/shared/agents";
import { formatCompactMicroUsd } from "@/shared/money";
import { AgentAvatar } from "./avatar";

export function AgentStatus({ agent }: { readonly agent: AgentSummary }): ReactElement {
  return (
    <Badge tone={agent.status === "running" ? "accent" : agent.status === "error" ? "warn" : "neutral"} dot>
      {agent.status[0]?.toUpperCase()}
      {agent.status.slice(1)}
    </Badge>
  );
}

export function AgentCard({ agent }: { readonly agent: AgentSummary }): ReactElement {
  return (
    <article className="card-shine flex min-w-0 flex-col gap-5 rounded-lg p-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar id={agent.id} running={agent.status === "running"} />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-h3">
              <Link href={`/agents/${agent.id}`} className="rounded-xs hover:text-accent-text">
                {agent.name}
              </Link>
            </h2>
            <p className="text-caption text-fg-muted">
              {PACKS[agent.pack].label} · v{agent.version}
            </p>
          </div>
        </div>
        <AgentStatus agent={agent} />
      </div>
      <p className="line-clamp-2 min-h-10 text-small leading-relaxed text-fg-muted">{agent.strategyText}</p>
      <dl className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-fg-subtle">Budget cap</dt>
          <dd className="font-mono text-num-lg tabular-nums" title={`$${agent.policy.budgetUsd}`}>
            {formatCompactMicroUsd(parseUsd(agent.policy.budgetUsd))}
          </dd>
        </div>
        <div className="flex flex-col gap-1 text-right">
          <dt className="text-caption text-fg-subtle">Realized PnL</dt>
          <dd className="font-mono text-num-lg tabular-nums">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Performance valuation unavailable</span>
          </dd>
        </div>
      </dl>
      <p className="text-caption leading-relaxed text-fg-subtle">{agent.reason}</p>
      <div className="mt-auto flex items-center justify-between gap-3">
        <Badge tone="neutral">Verified AI</Badge>
        <Link
          href={`/agents/${agent.id}`}
          aria-label={`View ${agent.name}`}
          className="inline-flex min-h-10 items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
        >
          View agent
          <ArrowUpRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </article>
  );
}
