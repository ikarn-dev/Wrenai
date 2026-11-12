import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { isRemovedExecutablePack } from "@/shared/agent-scope";
import { type AgentCardItem, type AgentSummary, PACKS, parseUsd } from "@/shared/agents";
import { formatCompactMicroUsd } from "@/shared/money";
import { AgentAvatar } from "./avatar";

const STATUS_WORDS: Readonly<Record<AgentSummary["status"], string>> = {
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  error: "Needs attention",
};

export function AgentStatus({
  agent,
}: {
  readonly agent: { readonly status: AgentSummary["status"]; readonly returningFunds: boolean };
}): ReactElement {
  if (agent.returningFunds) {
    return (
      <Badge tone="warn" dot>
        Claiming funds
      </Badge>
    );
  }
  return (
    <Badge tone={agent.status === "running" ? "accent" : agent.status === "error" ? "warn" : "neutral"} dot>
      {STATUS_WORDS[agent.status]}
    </Badge>
  );
}

/** What the agent does, as a short badge beside its generated name ("Spot Trader", "DCA"). */
export function AgentTypeBadge({
  pack,
  testnet = false,
}: {
  readonly pack: AgentSummary["pack"];
  readonly testnet?: boolean;
}): ReactElement {
  return (
    <Badge tone="neutral">
      {testnet && pack === "private_payments" ? "Payments" : PACKS[pack].label.replace(/ Agent$/, "")}
      {isRemovedExecutablePack(pack) ? " · Removed" : ""}
    </Badge>
  );
}

/** One agent as a single link: name and type, status, its instructions and spending limit. */
export function AgentCard({
  agent,
  href,
  budgetLabel,
}: {
  readonly agent: Pick<
    AgentCardItem,
    "id" | "name" | "pack" | "status" | "reason" | "strategyText" | "returningFunds"
  > &
    Partial<Pick<AgentCardItem, "budgetUsd">>;
  readonly href?: `/testnet/agents/${string}`;
  readonly budgetLabel?: ReactNode;
}): ReactElement {
  return (
    <Link
      href={href ?? `/agents/${agent.id}`}
      className="group flex min-w-0 flex-col gap-4 card-shine rounded-lg p-4 transition-[scale] duration-200 ease-ios active:scale-99 motion-reduce:active:scale-100"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar running={agent.status === "running"} size={32} />
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <h3 className="max-w-full truncate text-body font-medium text-fg-strong">{agent.name}</h3>
            <AgentTypeBadge pack={agent.pack} testnet={href !== undefined} />
          </div>
        </div>
        <AgentStatus agent={agent} />
      </div>
      <p className="line-clamp-2 min-h-10 text-small text-fg-muted">{agent.strategyText}</p>
      {agent.status === "error" ? (
        <p className="line-clamp-2 text-caption text-warn">{agent.reason}</p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-line-card pt-3 text-small">
        <span className="text-fg-subtle">
          Spends up to{" "}
          <span
            className="font-mono tabular-nums text-fg-strong"
            title={agent.budgetUsd ? `$${agent.budgetUsd}` : undefined}
          >
            {budgetLabel ?? (agent.budgetUsd ? formatCompactMicroUsd(parseUsd(agent.budgetUsd)) : "—")}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-fg-muted transition-colors duration-200 ease-ios group-hover:text-fg-strong">
          Open
          <ArrowRight
            aria-hidden="true"
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            className="transition-transform duration-200 ease-ios group-hover:translate-x-0.5"
          />
        </span>
      </div>
    </Link>
  );
}
