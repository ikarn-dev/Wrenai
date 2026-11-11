"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { readTrading } from "@/components/trading/trading-api";
import { Button } from "@/components/ui/button";
import { ElapsedBadge } from "@/components/ui/elapsed-badge";
import { recoverAgentOrders } from "@/server/engine/status-actions";
import { type AgentRuntimeStatus, agentRuntimeStatusSchema } from "@/shared/agent-runtime";
import type { AgentSummary } from "@/shared/agents";
import { AgentStatus } from "./agent-card";
import { AgentControls } from "./controls";

export function AgentRuntimePanel({
  agent,
  initial,
  executionAvailable,
  ownerId,
}: {
  readonly agent: AgentSummary;
  readonly initial: AgentRuntimeStatus;
  readonly executionAvailable: boolean;
  readonly ownerId: string;
}): ReactElement {
  const cache = useQueryClient();
  const key = ["agent-runtime", ownerId, agent.id, agent.revision];
  const query = useQuery({
    queryKey: key,
    initialData: initial,
    queryFn: ({ signal }) =>
      readTrading(
        `/api/agents/${encodeURIComponent(agent.id)}?view=runtime`,
        agentRuntimeStatusSchema,
        signal,
      ),
    refetchInterval: (query) => {
      const state = query.state.data;
      if (state?.agent.deleted) {
        return false;
      }
      return state?.agent.status === "running" ||
        state?.agent.returningFunds ||
        state?.runtime?.state === "starting" ||
        state?.pending.length
        ? 5000
        : 60_000;
    },
    staleTime: 5000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const recovery = useMutation({
    mutationFn: async () => {
      const result = await recoverAgentOrders({ agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    onSuccess: (value) => cache.setQueryData(key, value),
  });
  const snapshot = query.data;
  const current = { ...agent, ...snapshot.agent };
  const starting = snapshot.runtime?.state === "starting";
  if (snapshot.agent.deleted || (snapshot.agent.deleting && !snapshot.agent.returningFunds)) {
    return (
      <section aria-label="Trading status" className="flex flex-col items-start gap-3">
        <p role="status" className="text-small text-fg-muted">
          {snapshot.agent.deleted
            ? "This agent is deleted."
            : "This agent is deleted. Its funds wait in Claims."}
        </p>
        <div className="flex flex-wrap gap-4">
          <Link href="/claims" className="text-small text-accent-text underline underline-offset-4">
            Open Claims
          </Link>
          <Link href="/agents" className="text-small text-accent-text underline underline-offset-4">
            Back to agents
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Trading status" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {snapshot.agent.returningSince === null ? (
          <AgentStatus agent={current} />
        ) : (
          <ElapsedBadge label="Claiming funds" since={snapshot.agent.returningSince} />
        )}
        <p role="status" className="text-small text-fg-muted">
          {starting ? "Waiting for the trading workflow to start." : current.reason}
        </p>
      </div>
      <AgentControls agent={current} executionAvailable={executionAvailable && !starting && !query.isError} />
      {snapshot.pending.length > 0 && !snapshot.agent.returningFunds ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            disabled={recovery.isPending}
            aria-busy={recovery.isPending}
            onClick={() => recovery.mutate()}
          >
            <RefreshCw aria-hidden="true" size={16} />
            {recovery.isPending ? "Reconciling…" : "Reconcile orders"}
          </Button>
          <p className="text-caption text-fg-muted">
            Funds stay reserved until each submitted order is accounted for. Reconciliation does not place
            trades.
          </p>
        </div>
      ) : null}
      {query.isError || recovery.isError ? (
        <p role="alert" className="text-small text-warn">
          {recovery.error instanceof Error
            ? recovery.error.message
            : "Status could not be refreshed. The last confirmed state is shown."}
        </p>
      ) : null}
    </section>
  );
}
