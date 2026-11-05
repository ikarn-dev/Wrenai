"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactElement, useState, useTransition } from "react";
import { TokenBudget } from "@/components/agents/token-budget";
import { ResearchCards } from "@/components/chat/research-cards";
import { Button } from "@/components/ui/button";
import { useToastState } from "@/components/ui/toast";
import { saveChatAgentSetup } from "@/server/chat/draft-actions";
import { type AgentBudgetInput, budgetTokenAmount } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { packSchema } from "@/shared/agents";
import type { AgentSetupDraft } from "@/shared/research";

export function AgentSetupReview({ draft }: { readonly draft: AgentSetupDraft }): ReactElement {
  const router = useRouter();
  const [brief, setBrief] = useState(draft.brief);
  const [budget, setBudget] = useState<AgentBudgetInput | null>(
    draft.budget
      ? {
          assetId: draft.budget.assetId,
          amount: budgetTokenAmount(draft.budget.units, draft.budget.decimals),
        }
      : null,
  );
  const [busy, startTransition] = useTransition();
  const [, setMessage] = useToastState("info");
  function save(discard: boolean, reviewed = false): void {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await saveChatAgentSetup({
          id: draft.id,
          brief: discard ? null : brief,
          reviewed,
          ...(discard ? {} : { budget }),
        });
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        if (discard) {
          router.push("/agents");
        } else {
          setMessage(
            reviewed
              ? "Setup reviewed. Nothing starts until an agent is separately reviewed and activated."
              : "Setup saved.",
          );
          router.refresh();
        }
      } catch {
        setMessage("The change could not be confirmed. Try again.");
      }
    });
  }
  const active = isActiveAgentTool(draft.tool);
  const supported = active && packSchema.safeParse(draft.tool).success;
  if (draft.agentId) {
    return (
      <div className="mx-auto flex max-w-reading flex-col gap-4">
        <h1 className="text-h1">{AGENT_CATALOG[draft.tool].name}</h1>
        <p className="text-small text-fg-muted">
          This setup has been saved as an agent. Its allocation is retained until changed through the agent's
          funding flow.
        </p>
        <Link
          href={`/agents/${draft.agentId}`}
          className="inline-flex min-h-11 items-center text-small text-accent-text"
        >
          Manage agent
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-reading flex-col gap-6">
      <Link href="/agents" className="text-small text-fg-muted hover:text-fg">
        Back to agents
      </Link>
      <header className="space-y-2">
        <h1 className="text-h1">{AGENT_CATALOG[draft.tool].name} setup</h1>
        <p className="text-small text-fg-muted">
          {draft.reviewState === "reviewed" ? "Reviewed setup" : "Draft"} ·{" "}
          {!active
            ? "removed agent type · history only"
            : supported
              ? "not activated"
              : "execution unavailable"}
        </p>
      </header>
      <p className="text-body leading-relaxed text-fg-muted">
        Review the instructions and any attached research. Saving or marking this setup reviewed does not
        start trading. Setups remain until discarded.
      </p>
      {draft.briefTruncated ? (
        <p className="text-small text-warn">
          This setup was trimmed to 4,000 characters from the chat. Review every limit and condition before
          continuing.
        </p>
      ) : null}
      <label className="flex flex-col gap-2 text-small">
        Agent instructions
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          maxLength={4000}
          rows={6}
          className="rounded-sm border border-line bg-surface-1 p-3 text-body leading-relaxed"
        />
      </label>
      {active ? (
        <TokenBudget value={budget} onChange={setBudget} excludeId={draft.id} disabled={busy} />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy || !brief.trim()} onClick={() => save(false)}>
          {busy ? "Saving…" : "Save setup"}
        </Button>
        <Button disabled={busy || !brief.trim()} onClick={() => save(false, true)}>
          Mark reviewed
        </Button>
        <Link
          href={`/chat?tool=${draft.tool}`}
          className="inline-flex min-h-11 items-center rounded-sm px-3 text-small text-accent-text"
        >
          Refresh research
        </Link>
        <Button variant="destructive" disabled={busy} onClick={() => save(true)}>
          Discard setup
        </Button>
        {supported && brief === draft.brief ? (
          <Link
            href={`/agents?setup=${draft.id}`}
            className="inline-flex min-h-11 items-center rounded-sm px-3 text-small text-accent-text"
          >
            Review paused agent
          </Link>
        ) : null}
      </div>
      <ResearchCards reports={draft.reports} />
    </div>
  );
}
