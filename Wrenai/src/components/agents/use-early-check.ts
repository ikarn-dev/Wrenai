"use client";

import { useEffect, useRef } from "react";

/** How long the inputs must stay unchanged before the check starts. */
export const EARLY_CHECK_DELAY_MS = 1500;

export type EarlySettled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface EarlyCheck<T> {
  readonly key: string;
  readonly startedAt: number;
  /** Never rejects: failures settle as `ok: false`, so an unused check can't raise an unhandled rejection. */
  readonly result: Promise<EarlySettled<T>>;
}

/**
 * Starts a verified check in the background once its inputs (`key`) stop changing, so the wait happens while the
 * user is still on the form. A new key aborts the old check; `take` hands over the running or finished check only
 * if it belongs to exactly the inputs being submitted. A null key means the inputs aren't ready to check.
 */
export function useEarlyCheck<T>(
  key: string | null,
  run: (signal: AbortSignal) => Promise<T>,
): { readonly take: (key: string) => EarlyCheck<T> | null } {
  const current = useRef<EarlyCheck<T> | null>(null);
  // The latest run function, read when the timer fires; it changes every render with the inputs it closes over.
  const runner = useRef(run);
  useEffect(() => {
    runner.current = run;
  });
  useEffect(() => {
    if (key === null) {
      current.current = null;
      return;
    }
    if (current.current?.key === key) {
      return;
    }
    current.current = null;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const result = runner.current(controller.signal).then(
        (value): EarlySettled<T> => ({ ok: true, value }),
        (error: unknown): EarlySettled<T> => ({ ok: false, error }),
      );
      current.current = { key, startedAt: Date.now(), result };
    }, EARLY_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return {
    take: (wanted) => {
      const check = current.current;
      return check?.key === wanted ? check : null;
    },
  };
}
