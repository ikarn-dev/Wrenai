"use client";

import { useLenis } from "lenis/react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentKeyIntro } from "./agent-key-intro";
import { AuthorizeKeyPanel } from "./authorize-key-panel";

interface AgentKeyDialogProps {
  readonly accountId: string;
  readonly onAuthorized?: () => Promise<void>;
}

/**
 * The agent key popup, centered over the page. "Later", Escape or a click outside close it. While the wallet step
 * runs it can't be closed, so the result has somewhere to show. Success closes it and refreshes caller caches.
 */
export function AgentKeyDialog({ accountId, onAuthorized }: AgentKeyDialogProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const lenis = useLenis();
  const router = useRouter();

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
      // Non-modal while the wallet approves, so its window can take clicks and focus.
      modal={!working}
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
        {working ? (
          <div aria-hidden="true" className="fixed inset-0 z-40 bg-bg/80" />
        ) : (
          <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
        )}
        <Dialog.Content className="fixed inset-x-gutter top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 card-shine rounded-xl p-card text-center">
          <Dialog.Title className="font-rounded text-h1 font-bold">Let your agents trade</Dialog.Title>
          <Dialog.Description asChild>
            <div>
              <AgentKeyIntro />
            </div>
          </Dialog.Description>
          <div className="mt-6">
            <AuthorizeKeyPanel
              accountId={accountId}
              onLater={close}
              onWorkingChange={setWorking}
              onAuthorized={async () => {
                setOpen(false);
                // A caller that tracks the key in its own queries refreshes those; otherwise the page shows the new key.
                if (onAuthorized) {
                  await onAuthorized();
                } else {
                  router.refresh();
                }
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
