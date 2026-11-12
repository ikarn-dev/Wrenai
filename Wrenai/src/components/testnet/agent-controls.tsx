"use client";
import { HandCoins, Play, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertDialog } from "radix-ui";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { TestnetSnapshot } from "@/shared/testnet";
import { testnetApi } from "./api";
import { useTestnetData } from "./data-provider";

type Command = "stop" | "restart" | "delete";
// 14 px icons beside small labels (Docs/DESIGN.md → Icons).
const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const DONE: Readonly<Record<Command, string>> = {
  stop: "Agent stopped. Its funds wait in Claims.",
  restart: "Agent restarted.",
  delete: "Agent deleted. Its funds wait in Claims.",
};

/** Stop, Restart and Delete for a testnet agent, matching mainnet: nothing is sent; funds wait in Claims. */
export function TestnetAgentControls({
  agent,
}: {
  readonly agent: TestnetSnapshot["agents"][number];
}): ReactElement {
  const { refresh } = useTestnetData(),
    router = useRouter();
  const [running, setRunning] = useState<Command | null>(null),
    [confirmOpen, setConfirmOpen] = useState(false),
    [dialogError, setDialogError] = useState<string | null>(null);
  async function run(command: Command): Promise<void> {
    setRunning(command);
    setDialogError(null);
    try {
      await testnetApi({ command, id: agent.id });
      await refresh();
      toast.success(DONE[command]);
      if (command === "delete") {
        setConfirmOpen(false);
        router.push("/testnet/agents");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "The agent could not be updated.";
      if (command === "delete") {
        setDialogError(message);
      } else {
        toast.error(message);
      }
    } finally {
      setRunning(null);
    }
  }
  const busy = running !== null;
  const live = agent.state === "running" || agent.state === "blocked";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {live ? (
        <Button
          variant="soft"
          size="sm"
          disabled={busy && running !== "stop"}
          busy={running === "stop"}
          onClick={() => {
            void run("stop");
          }}
        >
          <Square {...ICON} />
          Stop
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={busy && running !== "restart"}
          busy={running === "restart"}
          onClick={() => {
            void run("restart");
          }}
        >
          <Play {...ICON} />
          Restart
        </Button>
      )}
      <Link
        href="/testnet/claims"
        className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-small font-medium text-fg transition-colors duration-300 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:h-11"
      >
        <HandCoins {...ICON} />
        Claim funds
      </Link>
      <AlertDialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) {
            setConfirmOpen(open);
            setDialogError(null);
          }
        }}
      >
        <AlertDialog.Trigger asChild>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${agent.name}`}>
            <Trash2 {...ICON} />
            Delete
          </Button>
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dialog-scrim fixed inset-0 z-40 bg-bg/80" />
          <AlertDialog.Content
            onEscapeKeyDown={(event) => (busy ? event.preventDefault() : undefined)}
            className="dialog-panel fixed inset-x-gutter top-1/2 z-50 mx-auto flex max-w-md -translate-y-1/2 flex-col rounded-xl bg-surface-2 p-card shadow-float"
          >
            <AlertDialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
              Delete {agent.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-body text-fg-muted">
              It stops and leaves your agents. Nothing is sent: its funds wait in Claims until you claim them.
            </AlertDialog.Description>
            <div aria-live="polite">
              {dialogError ? (
                <p role="alert" className="mt-4 rounded-sm bg-loss-soft p-3 text-small text-loss">
                  {dialogError}
                </p>
              ) : null}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="soft" disabled={running === "delete"}>
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                variant="danger"
                busy={running === "delete"}
                onClick={() => {
                  void run("delete");
                }}
              >
                <Trash2 {...ICON} size={18} />
                Stop and delete
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
