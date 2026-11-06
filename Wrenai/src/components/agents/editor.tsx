"use client";

import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToastState } from "@/components/ui/toast";
import { parseAgentStrategy, saveAgentStrategy } from "@/server/agents/actions";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { agentSetupProfile } from "@/shared/agent-templates";
import {
  type AgentPolicy,
  type AgentSummary,
  PACKS,
  packSchema,
  policySchema,
  type StrategyDraft,
  strategyTextSchema,
} from "@/shared/agents";
import { Field, INPUT_CLASS, PolicyFields } from "./policy-fields";
import { StrategySummary } from "./strategy-summary";
import { StrategyTemplates } from "./strategy-templates";

/** Edits a saved agent's strategy. New agents are created in the Agents page's dialog (CreateAgentDialog). */
export function AgentEditor({ agent }: { readonly agent: AgentSummary }): ReactElement {
  const router = useRouter();
  const [pack, setPack] = useState(agent.pack);
  const [text, setText] = useState(agent.strategyText);
  const [policy, setPolicy] = useState<AgentPolicy>(agent.policy);
  const [draft, setDraft] = useState<StrategyDraft | null>(null);
  const [, setError] = useToastState("error");
  const [busy, startTransition] = useTransition();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [saveId, setSaveId] = useState<string | null>(null);
  const setup = agentSetupProfile(pack);

  function invalidate(): void {
    setDraft(null);
    setRequestId(null);
    setSaveId(null);
    setError(null);
  }

  function parse(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const instructions = strategyTextSchema.safeParse(text);
    if (!instructions.success) {
      setError(instructions.error.issues[0]?.message ?? "Check your instructions.");
      return;
    }
    setError(null);
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    startTransition(async () => {
      try {
        const result = await parseAgentStrategy({ requestId: id, pack, strategyText: text });
        if (!result.ok) {
          setError(result.message);
          if (result.code !== "in_progress" && result.code !== "unavailable") {
            setRequestId(null);
          }
          return;
        }
        setDraft(result.value);
      } catch {
        setError("The request could not finish. Try again to recover the same review.");
      }
    });
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (draft === null) {
      return;
    }
    const parsed = policySchema.safeParse(policy);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your limits.");
      return;
    }
    const id = saveId ?? crypto.randomUUID();
    setSaveId(id);
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveAgentStrategy({
          requestId: id,
          draftId: draft.id,
          policy: parsed.data,
          agentId: agent.id,
          expectedRevision: agent.revision,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        router.push(`/agents/${result.value.agentId}`);
        router.refresh();
      } catch {
        setError("The save could not be confirmed. Retry to recover it without creating a duplicate.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/agents/${agent.id}`}
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        Back to agent
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-h1">Edit {agent.name}</h1>
        <p className="max-w-2xl text-body text-fg-muted">Describe what to do and review the rules.</p>
      </header>
      <div className="grid items-start gap-stack xl:grid-cols-2">
        <form
          onSubmit={parse}
          aria-busy={busy && draft === null}
          className="card-shine flex min-w-0 flex-col gap-6 rounded-lg p-card"
        >
          <fieldset disabled={busy} className="flex flex-col gap-5">
            <legend className="mb-5 text-h3">Strategy</legend>
            <Field label="Strategy pack">
              <select
                className={INPUT_CLASS}
                value={pack}
                onChange={(event) => {
                  const parsed = packSchema.safeParse(event.target.value);
                  if (parsed.success) {
                    setPack(parsed.data);
                    invalidate();
                  }
                }}
              >
                {Object.entries(PACKS)
                  .filter(([value]) => isActiveAgentTool(value) || value === agent.pack)
                  .map(([value, item]) => (
                    <option key={value} value={value}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="text-small text-fg-muted">{PACKS[pack].description}</p>
            <StrategyTemplates
              key={pack}
              templates={setup.templates}
              hasInstructions={Boolean(text.trim())}
              onApply={(next) => {
                setText(next);
                invalidate();
              }}
            />
            <Field label={setup.instructions} hint={setup.guidance}>
              <textarea
                minLength={20}
                maxLength={4000}
                required
                rows={7}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  invalidate();
                }}
                placeholder="Write your instructions or apply a template."
                className="w-full resize-y rounded-sm border border-line bg-surface-2 p-3 text-body leading-relaxed text-fg-strong placeholder:text-fg-subtle"
              />
            </Field>
            <button
              type="button"
              className="w-fit cursor-pointer rounded-sm text-small text-fg-muted underline underline-offset-4 hover:text-fg-strong"
              onClick={() => {
                setText(AGENT_CATALOG[pack].fields.map((field) => `${field}: `).join("\n"));
                invalidate();
              }}
            >
              Use setup guide
            </button>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="submit" disabled={busy} aria-busy={busy && draft === null}>
              {busy && draft === null ? (
                <LoaderCircle aria-hidden="true" size={16} className="motion-safe:animate-spin" />
              ) : null}
              {busy && draft === null ? "Verifying strategy…" : "Review strategy"}
            </Button>
          </div>
        </form>
        {draft === null ? (
          <aside className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line p-card text-center">
            <h2 className="text-h3">Your strategy, translated</h2>
            <p className="max-w-sm text-small leading-relaxed text-fg-muted">
              Parsed rules will appear here for your review. Nothing trades when you save.
            </p>
          </aside>
        ) : (
          <m.form
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            onSubmit={save}
            className="card-shine flex min-w-0 flex-col gap-6 rounded-lg p-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-h3">Review the rules</h2>
              <Badge tone="accent">
                <Check aria-hidden="true" size={12} />
                Model verified
              </Badge>
            </div>
            <StrategySummary strategy={draft.strategy} assets={draft.assets} />
            <PolicyFields
              pack={draft.strategy.kind}
              policy={policy}
              onChange={(next) => {
                setPolicy(next);
                setSaveId(null);
              }}
              disabled={busy}
            />
            <p className="text-caption text-fg-subtle">
              Saved paused. Funding and Start are on the agent page.
            </p>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy && draft !== null}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </m.form>
        )}
      </div>
    </div>
  );
}
