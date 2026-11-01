import type { AgentSummary } from "./agents";

export interface AgentRuntimeStatus {
  readonly agent: Pick<AgentSummary, "id" | "status" | "reason" | "revision" | "updatedAt">;
  readonly runtime: {
    readonly state: "starting" | "active" | "stopped" | "blocked";
    readonly nextCheckAt: number;
  } | null;
  readonly pending: readonly {
    readonly id: string;
    readonly status: string;
    readonly startedAt: number | null;
  }[];
}
