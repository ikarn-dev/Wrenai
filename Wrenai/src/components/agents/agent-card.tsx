import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { isRemovedExecutablePack } from "@/shared/agent-scope";
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

const FIGURE = "flex flex-col gap-1";
const FIGURE_TERM = "font-mono text-eyebrow uppercase text-fg-subtle";

/** One agent: mark, name and status; its strategy; budget and PnL; why it is in its state; a link to it. */
export function AgentCard({ agent }: { readonly agent: AgentSummary }): ReactElement {
  return (
    <article className="flex min-w-0 flex-col gap-4 card-shine rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar running={agent.status === "running"} size={28} />
          <div className="flex min-w-0 flex-col">
            <h3 className="truncate text-body font-medium text-fg-strong">
              <Link href={`/agents/${agent.id}`} className="rounded-xs hover:text-accent-text">
                {agent.name}
              </Link>
            </h3>
            <p className="text-caption text-fg-subtle">
              {PACKS[agent.pack].label} · v{agent.version}
              {isRemovedExecutablePack(agent.pack) ? " · Removed" : ""}
            </p>
          </div>
        </div>
        <AgentStatus agent={agent} />
      </div>
      <p className="line-clamp-2 min-h-10 text-small text-fg-muted">{agent.strategyText}</p>
      <dl className="grid grid-cols-2 gap-4 rounded-lg-inset bg-sunken p-3 ring-1 ring-line-card ring-inset">
        <div className={FIGURE}>
          <dt className={FIGURE_TERM}>Budget cap</dt>
          <dd className="font-mono text-num-lg text-fg-strong" title={`$${agent.policy.budgetUsd}`}>
            {formatCompactMicroUsd(parseUsd(agent.policy.budgetUsd))}
          </dd>
        </div>
        <div className={`${FIGURE} text-right`}>
          <dt className={FIGURE_TERM}>Realized PnL</dt>
          <dd className="font-mono text-num-lg text-fg-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Performance valuation unavailable</span>
          </dd>
        </div>
      </dl>
      <div className="mt-auto flex items-end justify-between gap-3">
        <p className="line-clamp-2 text-caption text-fg-subtle">{agent.reason}</p>
        <Link
          href={`/agents/${agent.id}`}
          aria-label={`View ${agent.name}`}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-2 text-small text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:h-11"
        >
          View
          <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
        </Link>
      </div>
    </article>
  );
}
