import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { AgentSummary } from "@/shared/agents";
import { AgentTypeBadge } from "./agent-card";
import { AgentAvatar } from "./avatar";

/** The agent page's top: a back link, then the avatar, generated name and type on one line. Both networks. */
export function AgentPageHeader({
  name,
  pack,
  running,
  backHref,
  testnet = false,
}: {
  readonly name: string;
  readonly pack: AgentSummary["pack"];
  readonly running: boolean;
  readonly backHref: "/agents" | "/testnet/agents";
  readonly testnet?: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link
        href={backHref}
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted transition-colors duration-300 ease-ios hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
        All agents
      </Link>
      <header className="flex min-w-0 items-center gap-3">
        <AgentAvatar running={running} size={32} />
        <h1 className="min-w-0 truncate text-h1" title={name}>
          {name}
        </h1>
        <AgentTypeBadge pack={pack} testnet={testnet} />
      </header>
    </div>
  );
}

/**
 * One toolbar row under the header: status and its reason on the left, the agent's actions on the right. It wraps
 * to two rows on narrow screens, actions second.
 */
export function AgentToolbar({
  status,
  reason,
  children,
}: {
  readonly status: ReactNode;
  readonly reason: string | null;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-line-subtle py-3">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <span className="shrink-0">{status}</span>
        {reason ? (
          <p role="status" title={reason} className="min-w-0 truncate text-small text-fg-muted">
            {reason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
