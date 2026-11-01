"use client";

import { LoaderCircle, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactElement, useState, useTransition } from "react";
import { removeAgentSetup } from "@/server/chat/draft-actions";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import type { AgentSetupDraft } from "@/shared/research";
import { AgentAvatar } from "./avatar";

/**
 * A saved setup as a card that opens it, with a dismiss button in the corner. The button sits beside the link,
 * not inside it (a button can't nest in a link). Dismissing deletes the draft: no confirm, since a draft never
 * runs and can be recreated. While it runs the icon becomes a spinner and clicks are ignored.
 */
export function SetupCard({ setup }: { readonly setup: AgentSetupDraft }): ReactElement {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const name = AGENT_CATALOG[setup.tool].name;

  function dismiss(): void {
    if (busy) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await removeAgentSetup({ id: setup.id }).catch(() => null);
      if (result?.ok) {
        router.refresh();
      } else {
        setError(result?.message ?? "Couldn't remove this setup. Try again.");
      }
    });
  }

  return (
    <div className="group relative min-w-0">
      <Link
        href={`/agents/setup/${setup.id}`}
        className="flex h-full min-w-0 flex-col gap-3 card-shine rounded-lg p-4 pr-12 transition-[scale] duration-200 ease-ios active:scale-99 motion-reduce:active:scale-100"
      >
        <span className="flex items-center gap-2.5">
          <AgentAvatar size={20} />
          <span className="truncate text-body font-medium text-fg-strong group-hover:text-accent-text">
            {name}
          </span>
        </span>
        <span className="line-clamp-2 text-small text-fg-muted">{setup.brief}</span>
        <span className="mt-auto font-mono text-eyebrow uppercase text-fg-subtle">
          {error ?? (setup.reviewState === "reviewed" ? "Reviewed" : "Draft")}
        </span>
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-busy={busy}
        aria-label={busy ? `Removing ${name} setup` : `Remove ${name} setup`}
        title="Remove setup"
        className="absolute top-3 right-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong aria-busy:cursor-progress pointer-coarse:size-11"
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
          <X size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {error ?? ""}
      </span>
    </div>
  );
}
