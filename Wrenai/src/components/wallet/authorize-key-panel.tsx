"use client";

import { Fuel, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusLine } from "@/components/ui/status-line";
import { authorizeAgentKey } from "./agent-key-flows";
import type { FlowPhase } from "./notices";

interface AuthorizeKeyPanelProps {
  readonly accountId: string;
  /** "Later": closes the popup this panel sits in. */
  readonly onLater: () => void;
  /** Told when the wallet step starts and stops, so the popup can stay open while it runs. */
  readonly onWorkingChange: (working: boolean) => void;
}

export function AuthorizeKeyPanel({ accountId, onLater, onWorkingChange }: AuthorizeKeyPanelProps) {
  const [phase, setPhase] = useState<FlowPhase>({ kind: "idle" });

  function show(next: FlowPhase): void {
    setPhase(next);
    onWorkingChange(next.kind === "working");
  }

  async function authorize(): Promise<void> {
    show({ kind: "working", label: "Preparing…" });
    const notice = await authorizeAgentKey(accountId, (label) => show({ kind: "working", label }));
    // On success the action has refreshed the page, which no longer renders the popup.
    if (notice !== null) {
      show({ kind: "stopped", notice });
    }
  }

  const working = phase.kind === "working";
  return (
    <div className="flex flex-col gap-4">
      {/* Two equal columns; grid cells stretch each button to its column. Both are raised (soft and primary), so
          they share one height and the same press. */}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" disabled={working} onClick={onLater}>
          Later
        </Button>
        <Button
          variant="primary"
          aria-busy={working}
          onClick={() => {
            if (!working) {
              void authorize();
            }
          }}
        >
          {working ? null : (
            <KeyRound
              aria-hidden="true"
              size={16}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className="shrink-0"
            />
          )}
          <span className="min-w-0 truncate">{working ? phase.label : "Set up key"}</span>
        </Button>
      </div>
      <StatusLine
        notice={phase.kind === "stopped" ? phase.notice : null}
        note={
          <>
            <Fuel aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
            <span className="min-w-0 text-small">One approval in your wallet. Tiny network fee.</span>
          </>
        }
      />
    </div>
  );
}
