import type { AgentRuntimeStatus } from "@/shared/agent-runtime";
import { type AgentSummary, parseUsd } from "@/shared/agents";
import { formatExactMicroUsd } from "@/shared/money";
import type { LiveModel, LivePhase } from "./live-model";

// Strategies the worker checks every five seconds against live prices (engine/check.ts → marketCheckSeconds).
const WATCHING: ReadonlySet<string> = new Set([
  "triggers",
  "spot_trader",
  "buy_the_dip",
  "sell_the_top",
  "perps",
  "meme_hunter",
]);

function phaseOf(agent: AgentSummary, status: AgentRuntimeStatus): LivePhase {
  const action = status.pending[0];
  if (action) {
    return action.status === "submitted" || action.status === "unknown" ? "settling" : "submitting";
  }
  if (agent.status === "error") {
    return "blocked";
  }
  if (agent.status !== "running" || status.agent.returningFunds) {
    return "stopped";
  }
  if (status.runtime === null || status.runtime.state === "starting") {
    return "starting";
  }
  if (status.runtime.state !== "active") {
    return "stopped";
  }
  return WATCHING.has(agent.pack) ? "watching" : "waiting";
}

/**
 * The live view for a mainnet agent from its runtime status: the worker's next check, its open action and, for a
 * reviewed DCA instruction, completed runs against the schedule. Other strategies show no fixed order count.
 */
export function mainnetLiveModel(agent: AgentSummary, status: AgentRuntimeStatus): LiveModel {
  const strategy = agent.strategy,
    instruction = "format" in strategy ? strategy : null,
    dca = instruction?.kind === "dca" ? instruction : null,
    interval = dca?.schedule.type === "interval" ? dca.schedule : null,
    endsAt = instruction ? Date.parse(instruction.expiresAt) : null,
    startedAt = interval ? Date.parse(interval.startAt) : agent.createdAt,
    done = status.runs ?? 0;
  const cadenceMs = interval ? interval.intervalSeconds * 1000 : null;
  const fits =
    dca && cadenceMs !== null && endsAt !== null
      ? Math.min(dca.maxRuns, Math.max(0, Math.floor((endsAt - 1 - startedAt) / cadenceMs) + 1))
      : null;
  const phase = phaseOf(agent, status);
  return {
    phase: dca && done >= dca.maxRuns && phase === "stopped" ? "completed" : phase,
    nextAt: status.runtime?.nextCheckAt ?? null,
    cadenceMs,
    startedAt,
    endsAt,
    done,
    planned: dca ? dca.maxRuns : null,
    fits,
    budget: `${formatExactMicroUsd(parseUsd(agent.policy.budgetUsd))} in total`,
    orderTimes: [],
  };
}
