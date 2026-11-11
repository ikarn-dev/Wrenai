"use client";

import { type ReactElement, useEffect, useState } from "react";
import { type BadgeTone, badgeShape } from "@/components/ui/badge";

/** Milliseconds since `since`, ticking each second. Null until mounted, so the server and first paint agree. */
function useElapsed(since: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now === null ? null : Math.max(0, now - since);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * A status badge for work in progress: a pulsing dot, what is happening and how long it has run. Only this badge
 * re-renders each second. The clock is hidden from screen readers so it is not announced every tick.
 */
export function ElapsedBadge({
  label,
  since,
  tone = "warn",
}: {
  readonly label: string;
  readonly since: number;
  readonly tone?: BadgeTone;
}): ReactElement {
  return (
    <span className={badgeShape(tone, "sm")}>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
      />
      {label}
      <ElapsedTime since={since} />
    </span>
  );
}

/** Only the running `m:ss` clock, for a badge that sets its own shape. Hidden from screen readers. */
function ElapsedTime({ since }: { readonly since: number }): ReactElement | null {
  const elapsed = useElapsed(since);
  return elapsed === null ? null : (
    <span aria-hidden="true" className="font-mono tabular-nums">
      {formatElapsed(elapsed)}
    </span>
  );
}
