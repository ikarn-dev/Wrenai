"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLenis } from "lenis/react";
import { HandCoins, LoaderCircle, Pause, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertDialog } from "radix-ui";
import { type ReactElement, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ElapsedBadge } from "@/components/ui/elapsed-badge";
import { notify, useToastState } from "@/components/ui/toast";
import type { AgentList, AgentSummary } from "@/shared/agents";
import { agentCommandRequest, stopRequest } from "./review-api";

type Command = "resume" | "pause" | "stop" | "delete" | "claim";
const PROGRESS: Readonly<Record<Command, string>> = {
  resume: "Starting",
  pause: "Pausing",
  stop: "Stopping",
  delete: "Deleting",
  claim: "Checking claim",
};
const ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

export function AgentControls({
  agent,
  executionAvailable,
}: {
  readonly agent: AgentSummary;
  readonly executionAvailable: boolean;
}): ReactElement {
  const router = useRouter();
  const cache = useQueryClient();
  const lenis = useLenis();
  const [busy, startTransition] = useTransition();
  const [, setError] = useToastState("error");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The command in flight and when it was clicked, so only its button spins and the badge counts from the click.
  const [pending, setPending] = useState<{ readonly command: Command; readonly since: number } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const request = useRef<{ command: string; id: string; revision: number } | null>(null);

  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!confirmOpen || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [confirmOpen, lenis]);

  // A failure inside the open dialog shows there; the toast sits behind its scrim.
  function fail(command: Command, message: string): void {
    if (command === "delete" && confirmOpen) {
      setDialogError(message);
    } else {
      setError(message);
    }
  }
  function changeOpen(next: boolean): void {
    if (busy) {
      return;
    }
    setConfirmOpen(next);
    setDialogError(null);
  }
  function run(command: Command): void {
    setError(null);
    setDialogError(null);
    setPending({ command, since: Date.now() });
    if (request.current?.command !== command || request.current.revision !== agent.revision) {
      request.current = { command, id: crypto.randomUUID(), revision: agent.revision };
    }
    const requestId = request.current.id;
    startTransition(async () => {
      try {
        const result = await agentCommandRequest(agent.id, {
          requestId,
          agentId: agent.id,
          expectedRevision: agent.revision,
          command,
        });
        if (!result.ok) {
          fail(command, result.message);
          return;
        }
        request.current = null;
        setConfirmOpen(false);
        // Only the status and the list change, so only those refetch; the page itself is not re-rendered.
        if (command === "delete") {
          // A deleted agent leaves the list at once; anything it still holds waits in Claims.
          cache.setQueriesData<AgentList>({ queryKey: ["agents"] }, (list) =>
            list ? { ...list, agents: list.agents.filter((item) => item.id !== agent.id) } : list,
          );
          await cache.invalidateQueries({ queryKey: ["pending-claims"] });
          router.push(result.value.deleted ? "/agents" : "/claims");
          return;
        }
        await Promise.all([
          cache.invalidateQueries({ queryKey: ["agent-runtime"] }),
          cache.invalidateQueries({ queryKey: ["agents"] }),
        ]);
      } catch {
        fail(command, "Could not confirm the change. Retry to recover the same request.");
      } finally {
        setPending(null);
      }
    });
  }
  /** The command's own icon, or the spinner while that command runs. */
  function icon(command: Command, idle: ReactNode): ReactNode {
    return isRunning(command) ? <LoaderCircle {...ICON} className="motion-safe:animate-spin" /> : idle;
  }
  function isRunning(command: Command): boolean {
    return busy && pending?.command === command;
  }
  // Button labels stay put while a command runs; the badge beside them says what is happening and for how long.
  const active = busy ? pending : null;
  const label = active && PROGRESS[active.command];
  const progress = active && label ? <ElapsedBadge label={label} since={active.since} /> : null;
  const announcement = (
    <span role="status" className="sr-only">
      {label ?? ""}
    </span>
  );
  if (agent.returningFunds) {
    // The claim is already under way; this retries anything that couldn't move yet. Nothing is sent twice.
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="soft"
          aria-busy={isRunning("claim")}
          onClick={() => (busy ? undefined : run("claim"))}
        >
          {icon("claim", <RefreshCw {...ICON} />)}
          Retry claim
        </Button>
        {progress}
        {announcement}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {agent.status === "running" ? (
          <Button
            variant="primary"
            disabled={busy && !isRunning("pause")}
            aria-busy={isRunning("pause")}
            onClick={() => (busy ? undefined : run("pause"))}
          >
            {icon("pause", <Pause {...ICON} />)}
            Pause
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={(busy && !isRunning("resume")) || !executionAvailable}
            aria-busy={isRunning("resume")}
            onClick={() => (busy ? undefined : run("resume"))}
            title={
              executionAvailable
                ? "Start the agent"
                : "Agents start on the Vercel app, or locally with WRENAI_LOCAL_EXECUTION=1, after their funds are in"
            }
          >
            {icon("resume", <Play {...ICON} />)}
            Start
          </Button>
        )}
        {/* The strategy and funds are set at deploy; afterwards an agent is only started, paused or stopped. */}
        {agent.status === "running" ? (
          <Button
            variant="soft"
            disabled={busy && !isRunning("stop")}
            aria-busy={isRunning("stop")}
            onClick={() => (busy ? undefined : run("stop"))}
          >
            {icon("stop", <Square {...ICON} />)}
            Stop
          </Button>
        ) : null}
        <Link
          href="/claims"
          className="inline-flex h-10 items-center gap-2 rounded-sm px-4 text-body font-medium text-fg transition-colors duration-300 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:h-11"
        >
          <HandCoins {...ICON} />
          Claim funds
        </Link>
        <AlertDialog.Root open={confirmOpen} onOpenChange={changeOpen}>
          <AlertDialog.Trigger asChild>
            <Button variant="ghost" disabled={busy} aria-label={`Delete ${agent.name}`}>
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
                It stops and leaves your agents. Nothing is sent: its funds wait in Claims until you claim
                them.
              </AlertDialog.Description>
              <div aria-live="polite">
                {dialogError ? (
                  <p role="alert" className="mt-4 rounded-sm bg-loss-soft p-3 text-small text-loss">
                    {dialogError}
                  </p>
                ) : null}
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
                <span className="mr-auto">{progress}</span>
                <AlertDialog.Cancel asChild>
                  <Button variant="soft" disabled={isRunning("delete")}>
                    Cancel
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  variant="danger"
                  aria-busy={isRunning("delete")}
                  onClick={() => (busy ? undefined : run("delete"))}
                >
                  {icon("delete", <Trash2 {...ICON} />)}
                  Stop and delete
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        {/* A delete shows its progress inside the open dialog instead. */}
        {confirmOpen ? null : progress}
      </div>
      {announcement}
    </div>
  );
}

/**
 * The kill switch (Spec §5 rule 2): one click, no confirm, stops every agent and blocks new trades. The request id
 * is reused on retry, so a double click or a lost reply never flips it twice. While it runs the button shows a
 * spinner and ignores clicks; the result appears as one line beside it.
 */
export function GlobalStop({
  engaged,
  revision,
}: {
  readonly engaged: boolean;
  readonly revision: number;
}): ReactElement {
  const cache = useQueryClient();
  const [busy, startTransition] = useTransition();
  const request = useRef<{ id: string; engaged: boolean; revision: number } | null>(null);
  const label = engaged ? "Clear stop" : "Stop all";

  function toggle(): void {
    if (busy) {
      return;
    }
    startTransition(async () => {
      if (request.current?.engaged !== !engaged || request.current.revision !== revision) {
        request.current = { id: crypto.randomUUID(), engaged: !engaged, revision };
      }
      const result = await stopRequest({
        engaged: !engaged,
        requestId: request.current.id,
        expectedRevision: revision,
      });
      if (result.ok) {
        request.current = null;
        await cache.invalidateQueries({ queryKey: ["agents"] });
      }
      if (result.ok) {
        notify("success", engaged ? "Stop cleared. Agents stay paused." : "All agents stopped.");
      } else {
        notify("warn", result.message);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-busy={busy}
        aria-label={busy ? `${label}: updating` : label}
        className={`inline-flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-sm px-3 text-small font-medium ring-1 ring-inset transition-colors duration-200 ease-ios aria-busy:cursor-default pointer-coarse:h-11 ${engaged ? "bg-surface-3 text-fg-strong ring-line-strong/50 hover:bg-surface-4" : "bg-loss-soft text-loss ring-loss/40 hover:ring-loss"}`}
      >
        {busy ? (
          <LoaderCircle
            size={14}
            strokeWidth={2}
            absoluteStrokeWidth
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : (
          <>
            <Square size={11} fill="currentColor" aria-hidden="true" />
            {label}
          </>
        )}
      </button>
    </div>
  );
}
