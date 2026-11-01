"use client";

import { useLenis } from "lenis/react";
import { AlertDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NoticeLine } from "@/components/ui/status-line";
import { revokeAgentKey } from "./agent-key-flows";
import type { FlowPhase } from "./notices";

interface RevokeKeyDialogProps {
  readonly accountId: string;
  readonly publicKey: string;
}

const IDLE: FlowPhase = { kind: "idle" };

export function RevokeKeyDialog({ accountId, publicKey }: RevokeKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<FlowPhase>(IDLE);
  const lenis = useLenis();
  const working = phase.kind === "working";

  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!open || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [open, lenis]);

  // While the wallet step runs the dialog stays open, so its result has somewhere to show.
  function changeOpen(next: boolean): void {
    if (working) {
      return;
    }
    setOpen(next);
    setPhase(IDLE);
  }

  async function revoke(): Promise<void> {
    setPhase({ kind: "working", label: "Connecting…" });
    const notice = await revokeAgentKey(accountId, publicKey, (label) =>
      setPhase({ kind: "working", label }),
    );
    // On success the action has refreshed the page, which no longer shows this dialog.
    if (notice !== null) {
      setPhase({ kind: "stopped", notice });
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={changeOpen}>
      <AlertDialog.Trigger asChild>
        <Button variant="destructive">Revoke agent key</Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-20 bg-bg/80" />
        <AlertDialog.Content className="fixed inset-x-gutter top-1/2 z-30 mx-auto max-w-md -translate-y-1/2 rounded-xl bg-surface-2 p-card shadow-float">
          <AlertDialog.Title className="font-rounded text-h2 font-bold">Revoke agent key?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-body text-fg-muted">
            Agents stop and can't trade until you authorize a new key. Your wallet asks you to approve the
            removal.
          </AlertDialog.Description>
          {/* The live region always exists, so screen readers announce a notice when it appears. */}
          <div aria-live="polite">
            {phase.kind === "stopped" ? (
              <p className="mt-4 text-body">
                <NoticeLine notice={phase.notice} />
              </p>
            ) : null}
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={working}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant="destructive"
              aria-busy={working}
              onClick={() => {
                if (!working) {
                  void revoke();
                }
              }}
            >
              {working ? phase.label : "Revoke"}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
