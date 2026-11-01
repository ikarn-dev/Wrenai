"use client";

import { Copy, Pause, Play, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertDialog } from "radix-ui";
import { type ReactElement, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { changeGlobalStop, manageAgent } from "@/server/agents/actions";
import type { AgentSummary } from "@/shared/agents";

export function AgentControls({
  agent,
  executionAvailable,
}: {
  readonly agent: AgentSummary;
  readonly executionAvailable: boolean;
}): ReactElement {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const request = useRef<{ command: string; id: string; revision: number } | null>(null);
  function run(command: "resume" | "pause" | "stop" | "clone" | "delete"): void {
    setError(null);
    if (request.current?.command !== command || request.current.revision !== agent.revision) {
      request.current = { command, id: crypto.randomUUID(), revision: agent.revision };
    }
    const requestId = request.current.id;
    startTransition(async () => {
      try {
        const result = await manageAgent({
          requestId,
          agentId: agent.id,
          expectedRevision: agent.revision,
          command,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        request.current = null;
        setConfirmOpen(false);
        if (command === "clone") {
          router.push(`/agents/${result.value.agentId}`);
        }
        if (command === "delete") {
          router.push("/agents");
        }
        router.refresh();
      } catch {
        setError("Could not confirm the change. Retry to recover the same request.");
      }
    });
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {agent.status === "running" ? (
          <Button disabled={busy} onClick={() => run("pause")}>
            <Pause aria-hidden="true" size={16} />
            Pause
          </Button>
        ) : (
          <Button
            disabled={busy || !executionAvailable}
            onClick={() => run("resume")}
            title={
              executionAvailable
                ? "Start the reviewed trading strategy"
                : "This tool needs a deployed trading runtime and a verified venue adapter"
            }
          >
            <Play aria-hidden="true" size={16} />
            {executionAvailable ? "Start" : "Trading unavailable"}
          </Button>
        )}
        {agent.status !== "stopped" ? (
          <Button disabled={busy} onClick={() => run("stop")}>
            <Square aria-hidden="true" size={16} />
            Stop
          </Button>
        ) : null}
        {agent.status !== "running" ? (
          <Link
            href={`/agents/${agent.id}/edit`}
            className="inline-flex h-10 items-center rounded-sm border border-line px-4 text-body text-fg hover:bg-surface-2"
          >
            Edit strategy
          </Link>
        ) : null}
        <Button variant="ghost" disabled={busy} onClick={() => run("clone")}>
          <Copy aria-hidden="true" size={16} />
          Clone
        </Button>
        <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialog.Trigger asChild>
            <Button
              variant="ghost"
              disabled={busy || agent.status === "running"}
              aria-label={`Delete ${agent.name}`}
            >
              <Trash2 aria-hidden="true" size={16} />
              Delete
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-bg/80" />
            <AlertDialog.Content className="card-shine fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-1/2 flex-col gap-5 rounded-lg p-card">
              <AlertDialog.Title className="text-h2">Delete {agent.name}?</AlertDialog.Title>
              <AlertDialog.Description className="text-body text-fg-muted">
                This removes the agent from your list. Its strategy and audit history are retained. It does
                not sell positions.
              </AlertDialog.Description>
              <div className="flex justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <Button disabled={busy}>Cancel</Button>
                </AlertDialog.Cancel>
                <Button variant="destructive" disabled={busy} onClick={() => run("delete")}>
                  {busy ? "Deleting…" : "Delete agent"}
                </Button>
              </div>
              {error ? (
                <p role="alert" className="text-small text-loss">
                  {error}
                </p>
              ) : null}
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
      {error && !confirmOpen ? (
        <p role="alert" className="text-small text-loss">
          {error}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {busy ? "Updating agent" : ""}
      </span>
    </div>
  );
}

export function GlobalStop({
  engaged,
  revision,
}: {
  readonly engaged: boolean;
  readonly revision: number;
}): ReactElement {
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef<{ id: string; engaged: boolean; revision: number } | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={engaged ? "secondary" : "destructive"}
        aria-label={engaged ? "Clear global stop" : "Stop all agents"}
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          startTransition(async () => {
            try {
              if (request.current?.engaged !== !engaged || request.current.revision !== revision) {
                request.current = { id: crypto.randomUUID(), engaged: !engaged, revision };
              }
              const result = await changeGlobalStop({
                engaged: !engaged,
                requestId: request.current.id,
                expectedRevision: revision,
              });
              if (result.ok) {
                request.current = null;
              }
              setMessage(
                result.ok
                  ? engaged
                    ? "Global stop cleared. Agents remain stopped."
                    : "All agents stopped."
                  : result.message,
              );
            } catch {
              setMessage("Could not confirm the global stop. Retry now.");
            }
          });
        }}
      >
        <Square aria-hidden="true" size={14} />
        <span>{busy ? "Updating…" : engaged ? "Clear global stop" : "Stop all agents"}</span>
      </Button>
      {message ? (
        <p role="status" className="text-caption text-fg-muted">
          {message}
        </p>
      ) : null}
    </div>
  );
}
