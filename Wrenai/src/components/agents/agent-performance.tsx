"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { readTrading } from "@/components/trading/trading-api";
import { agentPerformanceSchema } from "@/shared/agent-performance";
import { PerformanceTiles } from "./performance-tiles";

/** Live PnL for a mainnet agent: the Claims figures for this one agent, refreshed every 30 seconds while in view. */
export function AgentPerformance({
  agentId,
  ownerId,
}: {
  readonly agentId: string;
  readonly ownerId: string;
}): ReactElement {
  const query = useQuery({
    queryKey: ["agent-performance", ownerId, agentId],
    queryFn: ({ signal }) =>
      readTrading(
        `/api/agents/${encodeURIComponent(agentId)}?view=performance`,
        agentPerformanceSchema,
        signal,
      ),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return (
    <PerformanceTiles
      performance={query.data}
      error={query.isError ? "PnL couldn’t refresh. Retrying in 30 s." : null}
    />
  );
}
