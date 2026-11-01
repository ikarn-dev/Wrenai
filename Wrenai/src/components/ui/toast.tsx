"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

/** success: it worked. info: neutral result. warn: clears by waiting or retrying. error: needs something else. */
export type ToastTone = "success" | "info" | "warn" | "error";

/** Shows a new toast for an action's result. Every call adds one, so repeating an action always shows it again. */
export function notify(tone: ToastTone, message: string): void {
  switch (tone) {
    case "success":
      toast.success(message);
      return;
    case "info":
      toast.info(message);
      return;
    case "warn":
      toast.warning(message);
      return;
    case "error":
      toast.error(message);
      return;
    default: {
      const unhandled: never = tone;
      throw new Error(`Unhandled toast tone: ${String(unhandled)}`);
    }
  }
}

/**
 * Like useState for an action's message, but every non-null set also shows a toast, at the moment the event
 * happens, even when the text matches the last one. The value stays available for logic that depends on it.
 */
export function useToastState(tone: ToastTone): readonly [string | null, (next: string | null) => void] {
  const [value, setValue] = useState<string | null>(null);
  const set = useCallback(
    (next: string | null): void => {
      setValue(next);
      if (next) {
        notify(tone, next);
      }
    },
    [tone],
  );
  return [value, set] as const;
}
