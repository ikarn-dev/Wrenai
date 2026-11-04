"use client";

import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToastState } from "@/components/ui/toast";
import { createAgentWithBudget, parseAgentStrategy, saveAgentStrategy } from "@/server/agents/actions";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { isActiveAgentTool } from "@/shared/agent-scope";
import {
  type AgentPolicy,
  type AgentSummary,
  DEFAULT_POLICY,
  PACKS,
  packSchema,
  policySchema,
  type StrategyDraft,
} from "@/shared/agents";
import { Field, INPUT_CLASS, PolicyFields } from "./policy-fields";
import { StrategySummary } from "./strategy-summary";
import { TokenBudget } from "./token-budget";

export function AgentEditor({
  agent,
  setup,
  initialPack,
  initialBrief,
}: {
  readonly agent?: AgentSummary;
  readonly initialPack?: AgentSummary["pack"];
  readonly initialBrief?: string;
  readonly setup?: {
    readonly id: string;
    readonly hash: string;
    readonly pack: AgentSummary["pack"];
    readonly brief: string;
    readonly budget: AgentBudgetInput | null;
  };
}): ReactElement {
  const router = useRouter();
  const [pack, setPack] = useState(agent?.pack ?? setup?.pack ?? initialPack ?? "spot_trader");
  const [budget, setBudget] = useState<AgentBudgetInput | null>(setup?.budget ?? null);
  const [text, setText] = useState(agent?.strategyText ?? setup?.brief ?? initialBrief ?? "");
  const [policy, setPolicy] = useState<AgentPolicy>(
    agent?.policy ?? {
      ...DEFAULT_POLICY,
      allowRiskReducingExits: true,
      ...((setup?.pack ?? initialPack) === "perps" ? { maxProviderFeeBps: 10 } : {}),
    },
  );
  const [draft, setDraft] = useState<StrategyDraft | null>(null);
  const [, setError] = useToastState("error");
  const [busy, startTransition] = useTransition();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [saveId, setSaveId] = useState<string | null>(null);

  function invalidate(): void {
    setDraft(null);
    setRequestId(null);
    setSaveId(null);
    setError(null);
  }

  function parse(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    startTransition(async () => {
      try {
        const result = await parseAgentStrategy({
          requestId: id,
          pack,
          strategyText: text,
          ...(!agent && budget ? { budget } : {}),
        });
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
        const input = {
          requestId: id,
          draftId: draft.id,
          policy: parsed.data,
          agentId: agent?.id ?? null,
          expectedRevision: agent?.revision ?? null,
          ...(setup ? { setupId: setup.id, setupHash: setup.hash } : {}),
        };
        const result = !agent
          ? await createAgentWithBudget({ ...input, budget })
          : await saveAgentStrategy(input);
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
        href={agent ? `/agents/${agent.id}` : "/agents"}
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        Back to {agent ? "agent" : "agents"}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-h1">{agent ? `Edit ${agent.name}` : "New agent"}</h1>
        <p className="max-w-2xl text-body text-fg-muted">
          Describe what to do, choose a budget and review the rules.
        </p>
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
                disabled={!!setup}
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
                  .filter(([value]) => isActiveAgentTool(value) || value === agent?.pack)
                  .map(([value, item]) => (
                    <option key={value} value={value}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="text-small text-fg-muted">{PACKS[pack].description}</p>
            <p className="text-caption text-fg-subtle">
              Use the exact tokens and amounts you want this agent to use.
            </p>
            <Field
              label="What should this agent do?"
              hint="Include exact assets, amounts and price levels. No name needed."
            >
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
                placeholder={AGENT_CATALOG[pack].prompt}
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
          {!agent ? (
            <TokenBudget
              value={budget}
              onChange={(value) => {
                setBudget(value);
                invalidate();
              }}
              disabled={busy}
              {...(setup ? { excludeId: setup.id } : {})}
            />
          ) : null}
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
            <StrategySummary strategy={draft.strategy} />
            <PolicyFields
              policy={policy}
              onChange={(next) => {
                setPolicy(next);
                setSaveId(null);
              }}
              disabled={busy}
            />
            <p className="text-caption text-fg-subtle">
              Saved paused. Funding and Start are on the next screen.
            </p>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy && draft !== null}>
              {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
            </Button>
          </m.form>
        )}
      </div>
    </div>
  );
}
