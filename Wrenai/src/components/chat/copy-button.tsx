"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";

const ICON = { "aria-hidden": true, size: 13, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** A small icon-only copy control for message action rows: 28 px (44 px on touch), Check in mint once copied. */
export function CopyButton({
  text,
  label = "Copy message",
}: {
  readonly text: string;
  readonly label?: string;
}): ReactElement {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
      notify("warn", "Couldn't copy. Select the text to copy it.");
    }
    timer.current = setTimeout(() => setStatus("idle"), 2_000);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={status === "copied" ? "Copied" : label}
        title={label}
        onClick={() => void copy()}
        className={`inline-flex size-7 cursor-pointer items-center justify-center rounded-xs transition-colors duration-200 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:size-11 ${status === "copied" ? "text-accent-text" : "text-fg-subtle"}`}
      >
        {status === "copied" ? <Check {...ICON} /> : <Copy {...ICON} />}
      </button>
      <span role="status" className="sr-only">
        {status === "copied" ? "Copied to clipboard" : ""}
      </span>
    </span>
  );
}
