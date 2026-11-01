"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createAgentToolSetup } from "@/server/chat/draft-actions";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import type { ResearchTool } from "@/shared/research";

export function NewAgentSetup({ tool }: { readonly tool: ResearchTool }): ReactElement {
  const info = AGENT_CATALOG[tool];
  const router = useRouter();
  const [answers, setAnswers] = useState<readonly string[]>(["", "", ""]);
  const [notes, setNotes] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    request.current ??= crypto.randomUUID();
    const id = request.current;
    startTransition(async () => {
      try {
        const result = await createAgentToolSetup({ id, tool, answers, notes });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        router.push(`/agents/setup/${result.value.id}`);
      } catch {
        setError("The save could not be confirmed. Retry to recover the same setup.");
      }
    });
  }
  return (
    <div className="mx-auto flex max-w-reading flex-col gap-6">
      <Link href="/agents" className="text-small text-fg-muted hover:text-fg">
        Back to agents
      </Link>
      <header className="space-y-2">
        <h1 className="text-h1">{info.name}</h1>
        <p className="text-body text-fg-muted">{info.description}</p>
      </header>
      <p className="text-small text-fg-subtle">
        Create a setup to review. This does not enable trading or request wallet permissions.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-5" aria-busy={busy}>
        {info.fields.map((label, index) => (
          <label key={label} className="flex flex-col gap-2 text-small">
            {label}
            <textarea
              required
              disabled={busy}
              rows={2}
              maxLength={900}
              value={answers[index] ?? ""}
              onChange={(event) => {
                request.current = null;
                setAnswers((current) =>
                  current.map((value, position) => (position === index ? event.target.value : value)),
                );
              }}
              className="rounded-sm border border-line bg-surface-1 p-3 text-body leading-relaxed"
            />
          </label>
        ))}
        <label className="flex flex-col gap-2 text-small">
          Additional instructions <span className="text-caption text-fg-subtle">Optional</span>
          <textarea
            rows={3}
            maxLength={600}
            value={notes}
            disabled={busy}
            onChange={(event) => {
              request.current = null;
              setNotes(event.target.value);
            }}
            className="rounded-sm border border-line bg-surface-1 p-3 text-body leading-relaxed"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save setup"}
          </Button>
          <Link
            href={`/chat?tool=${tool}`}
            className="inline-flex min-h-11 items-center rounded-sm px-3 text-small text-accent-text"
          >
            Research first
          </Link>
        </div>
        {error ? (
          <p role="alert" className="text-small text-warn">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
