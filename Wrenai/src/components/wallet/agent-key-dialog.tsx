"use client";

import { useLenis } from "lenis/react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentKeyIntro } from "./agent-key-intro";
import { AuthorizeKeyPanel } from "./authorize-key-panel";

interface AgentKeyDialogProps {
  readonly accountId: string;
}

/**
 * The agent key popup, centered over the page. "Later", Escape or a click outside close it. While the wallet step
 * runs it can't be closed, so the result has somewhere to show. Setting the key up refreshes the page, which then
 * no longer renders this.
 */
export function AgentKeyDialog({ accountId }: AgentKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const lenis = useLenis();

  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!open || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [open, lenis]);

  function close(): void {
    if (working) {
      return;
    }
    setOpen(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
        } else {
          close();
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="secondary">Set up agent key</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
        <Dialog.Content className="fixed inset-x-gutter top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 card-shine rounded-xl p-card text-center">
          <Dialog.Title className="font-rounded text-h1 font-bold">Let your agents trade</Dialog.Title>
          <Dialog.Description asChild>
            <div>
              <AgentKeyIntro />
            </div>
          </Dialog.Description>
          <div className="mt-6">
            <AuthorizeKeyPanel accountId={accountId} onLater={close} onWorkingChange={setWorking} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
