"use client";
import { type ReactElement, type ReactNode, useState } from "react";

export function AgentAdvancedOptions({ children }: { readonly children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="space-y-4 rounded-lg border border-line p-card"
    >
      <summary className="cursor-pointer text-small text-fg-muted">More details and history</summary>
      {open ? <div className="mt-4 flex flex-col gap-stack">{children}</div> : null}
    </details>
  );
}
