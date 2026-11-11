"use client";

import { useQuery } from "@tanstack/react-query";
import { BrainCircuit } from "lucide-react";
import type { ReactElement } from "react";
import { PortfolioSection } from "@/components/portfolio/panel";
import { Badge } from "@/components/ui/badge";
import { AgentCard } from "./agent-card";
import { AgentListSkeleton } from "./agent-list-skeleton";
import { EMPTY_AGENTS_CARD, LIVE_COUNT_PLACEHOLDER } from "./agents-header";
import { GlobalStop } from "./controls";
import { readAgentList } from "./review-api";

/** The query key for the Agents list, shared by everything that changes an agent. */
export function agentListKey(ownerId: string): readonly string[] {
  return ["agents", ownerId];
}

/**
 * "Your agents": cards, the live count and the stop control. The list is a cached client query, so returning to
 * Agents shows it at once and any change updates it in place; the page itself waits on no list read.
 */
export function AgentsSection({ ownerId }: { readonly ownerId: string }): ReactElement {
  const query = useQuery({
    queryKey: agentListKey(ownerId),
    queryFn: ({ signal }) => readAgentList(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  if (!query.data) {
    return (
      <PortfolioSection id="your-agents" title="Your agents" aside={LIVE_COUNT_PLACEHOLDER}>
        {query.isError ? (
          <p role="alert" className="text-small text-warn">
            {query.error.message}
          </p>
        ) : (
          <AgentListSkeleton />
        )}
      </PortfolioSection>
    );
  }
  const { agents, stop } = query.data;
  const live = agents.filter((agent) => agent.status === "running").length;
  return (
    <PortfolioSection
      id="your-agents"
      title="Your agents"
      aside={
        <div className="flex items-center gap-4">
          <p className="flex items-center gap-2 text-small text-fg-muted">
            <Badge tone={live > 0 ? "accent" : "neutral"} dot>
              <span className="font-mono tabular-nums">{live}</span> live
            </Badge>
            <span>
              of <span className="font-mono tabular-nums text-fg-strong">{agents.length}</span>{" "}
              {agents.length === 1 ? "agent" : "agents"}
            </span>
          </p>
          {agents.length > 0 || stop.engaged ? (
            <GlobalStop engaged={stop.engaged} revision={stop.revision} />
          ) : null}
        </div>
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
  );
}
