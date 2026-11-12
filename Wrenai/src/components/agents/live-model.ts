export type LivePhase =
  | "starting"
  | "waiting"
  | "watching"
  | "quoting"
  | "submitting"
  | "settling"
  | "blocked"
  | "stopped"
  | "completed";

/** What the agent is doing now and what ends it, built from recorded state by each network's page. */
export interface LiveModel {
  readonly phase: LivePhase;
  /** When the next order or price check is due. */
  readonly nextAt: number | null;
  /** Time between orders, for the countdown ring; null when it acts on a condition rather than a schedule. */
  readonly cadenceMs: number | null;
  readonly startedAt: number;
  readonly endsAt: number | null;
  readonly done: number;
  /** Orders the budget pays for; null when the strategy has no fixed count. */
  readonly planned: number | null;
  /** How many of those fit before the end time; shown when it is fewer than planned. */
  readonly fits: number | null;
  readonly budget: string | null;
  readonly orderTimes: readonly number[];
  /** Its order is due but held back by an outage, so it retries shortly instead of placing it now. */
  readonly retrying?: boolean;
}

/** m:ss, or h:mm:ss from an hour, rounded up so it never shows 0:00 early. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
