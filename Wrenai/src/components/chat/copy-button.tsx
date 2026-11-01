"use client";

import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";

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
        className="inline-flex size-10 cursor-pointer items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-strong pointer-coarse:size-11"
      >
        {status === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <span role="status" className={status === "failed" ? "text-caption text-warn" : "sr-only"}>
        {status === "copied"
          ? "Copied to clipboard"
          : status === "failed"
            ? "Copy failed. Select the text to copy."
            : ""}
      </span>
    </span>
  );
}
