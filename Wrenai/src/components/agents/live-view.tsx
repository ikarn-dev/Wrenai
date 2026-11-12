"use client";

import { type ReactElement, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { StopConditions } from "./live-conditions";
import { countdown, type LiveModel, type LivePhase } from "./live-model";
import { LiveStage } from "./live-stage";

const STEPS = ["Wait", "Quote", "Submit", "Settle"] as const;
const ACTIVE: Readonly<Record<LivePhase, number | null>> = {
  starting: 0,
  waiting: 0,
  watching: 0,
  quoting: 1,
  submitting: 2,
  settling: 3,
  blocked: 3,
  stopped: null,
  completed: null,
};

/** The current time, once a second while `active`: a clock is an external system the view syncs with. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function headline(model: LiveModel, now: number): string {
  switch (model.phase) {
    case "starting":
      return "Starting up";
    case "waiting":
      return model.nextAt !== null && model.nextAt > now
        ? `Next order in ${countdown(model.nextAt - now)}`
        : model.retrying
          ? "Order paused · retrying shortly"
          : "Placing the next order";
    case "watching":
      return "Watching the price";
    case "quoting":
      return "Getting a fresh quote";
    case "submitting":
      return "Submitting the order";
    case "settling":
      return "Waiting for it to settle";
    case "blocked":
      return "Needs your review";
    case "stopped":
      return "Stopped";
    case "completed":
      return "Finished";
    default: {
      const unhandled: never = model.phase;
      throw new Error(`Unhandled phase ${String(unhandled)}`);
    }
  }
}

/** The order cycle as four equal segments: passed ones filled, the current one carrying a moving light. */
function Pipeline({ phase }: { readonly phase: LivePhase }): ReactElement {
  const active = ACTIVE[phase];
  return (
    <ol className="grid w-full grid-cols-4 gap-2 md:max-w-md" aria-label="Order cycle">
      {STEPS.map((step, index) => {
        const current = active === index,
          passed = active !== null && index < active;
        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span
              aria-hidden="true"
              className="relative block h-0.5 overflow-hidden rounded-full bg-line-card"
            >
              {passed ? <span className="absolute inset-0 bg-accent-line" /> : null}
              {current ? <span className="live-travel absolute inset-y-0 left-0 w-1/3 bg-accent" /> : null}
            </span>
            <span
              className={`truncate text-caption ${current ? "font-medium text-accent-text" : passed ? "text-fg" : "text-fg-subtle"}`}
            >
              {phase === "watching" && index === 0 ? "Watch" : step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The agent's live view: its timeline on top, where the pixel character acts out the current phase and roams while
 * it is live; then what it is doing now with the order cycle, and the figures that end it. Everything comes from recorded state; it re-renders once a second only
 * while the agent is live or has an end time to count down to.
 */
export function AgentLiveView({ model }: { readonly model: LiveModel }): ReactElement {
  const live = ACTIVE[model.phase] !== null;
  const now = useNow(live || model.endsAt !== null);
  const short = model.fits !== null && model.planned !== null && model.fits < model.planned;
  const waited =
    model.phase === "waiting" && model.nextAt !== null && model.cadenceMs !== null
      ? Math.min(1, Math.max(0, 1 - (model.nextAt - now) / model.cadenceMs))
      : 0;
  return (
    <section aria-label="Live activity" className="flex min-w-0 flex-col gap-5 card-shine rounded-lg p-card">
      <LiveStage model={model} now={now} progress={waited} />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <p role="status" className="truncate text-h3 text-fg-strong" suppressHydrationWarning>
            {headline(model, now)}
          </p>
          {short ? (
            <Badge tone="warn" dot>
              {model.fits} of {model.planned} orders fit in time
            </Badge>
          ) : null}
        </div>
        <Pipeline phase={model.phase} />
      </div>
      <StopConditions model={model} now={now} />
    </section>
  );
}
