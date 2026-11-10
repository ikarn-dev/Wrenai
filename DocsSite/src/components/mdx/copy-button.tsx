"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

const ICON = { "aria-hidden": true, size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** Copies a code block. Check in mint for two seconds, announced to screen readers; a refused copy says so. */
export function CopyButton({ text }: { readonly text: string }): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
      aria-label="Copy code"
      title="Copy code"
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11"
    >
      {state === "copied" ? <Check {...ICON} className="text-accent-text" /> : <Copy {...ICON} />}
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
