"use client";

import { type ReactElement, type RefObject, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";
import type { LiveModel, LivePhase } from "./live-model";
import { PixelAgent } from "./pixel-agent";

const UTC = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });
// Phases where the character roams and hops; stopped and blocked stand still where they are.
const LIVELY: ReadonlySet<LivePhase> = new Set([
  "starting",
  "waiting",
  "watching",
  "quoting",
  "submitting",
  "settling",
  "completed",
]);
// How far it may wander either side of "now" on the track, at most.
const MAX_ROAM_PX = 90;

type Action =
  | { readonly kind: "rest"; readonly until: number }
  | {
      readonly kind: "hop";
      readonly start: number;
      readonly duration: number;
      readonly from: number;
      readonly to: number;
      readonly height: number;
      readonly walking: boolean;
      /** Further walking hops after this one, so it covers ground in a little run. */
      readonly chain: number;
    };

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * The next thing the character does, chosen fresh each time so it never repeats a path: a joyful hop in place, a
 * short run of walking hops toward a new spot inside its range, or a pause.
 */
function nextAction(now: number, x: number, range: { readonly min: number; readonly max: number }): Action {
  const roll = Math.random();
  if (roll < 0.25) {
    return { kind: "rest", until: now + between(300, 1400) };
  }
  if (roll < 0.55) {
    return {
      kind: "hop",
      start: now,
      duration: between(420, 620),
      from: x,
      to: x,
      height: between(10, 20),
      walking: false,
      chain: 0,
    };
  }
  const step = between(10, 26) * (Math.random() < 0.5 ? -1 : 1);
  const to = Math.min(range.max, Math.max(range.min, x + step));
  return {
    kind: "hop",
    start: now,
    duration: between(280, 380),
    from: x,
    to,
    height: between(3, 8),
    walking: true,
    chain: Math.floor(between(1, 4)),
  };
}

/**
 * Moves the character with requestAnimationFrame, writing its transform straight to the element so nothing re-renders
 * per frame. It stays within the track and near "now"; `base` is read each frame, so it follows the clock.
 */
function useRoaming(
  actor: RefObject<HTMLDivElement | null>,
  track: RefObject<HTMLSpanElement | null>,
  base: RefObject<number>,
  active: boolean,
): void {
  useEffect(() => {
    const el = actor.current,
      bar = track.current;
    if (!el || !bar) {
      return;
    }
    const rest = "translate(-50%, 0)";
    if (!active) {
      el.style.transform = rest;
      el.removeAttribute("data-moving");
      return;
    }
    let x = 0,
      facing = 1,
      landedAt = 0,
      frame = 0,
      action: Action = { kind: "rest", until: performance.now() + 300 };
    const range = (): { readonly min: number; readonly max: number } => {
      const width = bar.clientWidth,
        half = el.clientWidth / 2,
        at = Math.min(width - half, Math.max(half, (base.current / 100) * width));
      return {
        min: Math.max(-MAX_ROAM_PX, half - at),
        max: Math.min(MAX_ROAM_PX, width - half - at),
      };
    };
    const tick = (now: number): void => {
      let y = 0;
      if (action.kind === "rest") {
        if (now >= action.until) {
          action = nextAction(now, x, range());
        }
      } else {
        const p = Math.min(1, (now - action.start) / action.duration);
        const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        x = action.from + (action.to - action.from) * eased;
        y = 4 * action.height * p * (1 - p);
        if (action.to !== action.from) {
          facing = action.to > action.from ? 1 : -1;
        }
        if (p >= 1) {
          landedAt = now;
          const { chain, walking, to } = action;
          const bounds = range();
          action =
            walking && chain > 0
              ? {
                  ...action,
                  start: now,
                  from: to,
                  to: Math.min(bounds.max, Math.max(bounds.min, to + (to - action.from || 12))),
                  chain: chain - 1,
                }
              : { kind: "rest", until: now + between(150, 900) };
        }
      }
      // A quick squash on landing; it settles over 120 ms.
      const squash = now - landedAt < 120 ? 0.88 + ((now - landedAt) / 120) * 0.12 : 1;
      el.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), ${(-y).toFixed(1)}px) scale(${facing * (2 - squash)}, ${squash})`;
      if (action.kind === "hop" && action.walking) {
        el.setAttribute("data-moving", "");
      } else {
        el.removeAttribute("data-moving");
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [actor, track, base, active]);
}

/**
 * The run's timeline as a stage: the pixel character stands on the track at "now" and, while the agent is live, roams
 * around it with free hops and little runs. Elapsed time fills the track and each order is a tick; without an end
 * time the track is just ground. The character is decorative; the figures below carry the information.
 */
export function LiveStage({
  model,
  now,
  progress,
}: {
  readonly model: LiveModel;
  readonly now: number;
  /** How far the wait for the next order has run, 0 to 1. */
  readonly progress: number;
}): ReactElement {
  const reduced = usePrefersReducedMotion();
  const actor = useRef<HTMLDivElement>(null),
    track = useRef<HTMLSpanElement>(null);
  const timed = model.endsAt !== null && model.endsAt > model.startedAt;
  const span = timed && model.endsAt !== null ? model.endsAt - model.startedAt : 1;
  const at = (time: number) => Math.min(100, Math.max(0, ((time - model.startedAt) / span) * 100));
  const position = timed ? at(Math.min(now, model.endsAt ?? now)) : 50;
  const base = useRef(position);
  useEffect(() => {
    base.current = position;
  });
  useRoaming(actor, track, base, LIVELY.has(model.phase) && !reduced);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="pt-16">
        <span ref={track} className="relative block h-1 rounded-full bg-surface-2">
          {timed ? (
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-accent-soft transition-[width] duration-1000 ease-linear"
              style={{ width: `${position}%` }}
            />
          ) : null}
          {timed
            ? model.orderTimes.map((time) => (
                <span
                  key={time}
                  className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                  style={{ left: `${at(time)}%` }}
                />
              ))
            : null}
          <span
            className="absolute bottom-full transition-[left] duration-1000 ease-linear"
            // Kept a half character from each end (h-16 at 150:74 is about 8.1rem wide), so it never leaves the card.
            style={{ left: `clamp(4.1rem, ${position}%, calc(100% - 4.1rem))` }}
          >
            <div ref={actor} className="group origin-bottom" style={{ transform: "translate(-50%, 0)" }}>
              <PixelAgent phase={model.phase} progress={progress} className="block h-16 w-auto" />
            </div>
          </span>
        </span>
      </div>
      {timed && model.endsAt !== null ? (
        <span
          aria-hidden="true"
          className="flex justify-between font-mono text-caption text-fg-subtle tabular-nums"
        >
          <span>{UTC.format(model.startedAt)}</span>
          <span>{UTC.format(model.endsAt)} UTC</span>
        </span>
      ) : null}
    </div>
  );
}
