"use client";

import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseAgentStrategy, saveAgentStrategy } from "@/server/agents/actions";
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

const EXAMPLES = {
  rebalancer:
    "Keep 50% NEAR and 50% USDC. Rebalance when either asset drifts 5% from its target, checking every 5 minutes.",
  triggers:
    "Buy $10 of NEAR with USDC when NEAR rises above $4. Take profit at $4.60 and stop loss at $3.80. Stop after the exit.",
} as const;

export function AgentEditor({
  agent,
  setup,
}: {
  readonly agent?: AgentSummary;
  readonly setup?: { readonly pack: "rebalancer" | "triggers"; readonly brief: string };
}): ReactElement {
  const router = useRouter();
  const [pack, setPack] = useState(agent?.pack ?? setup?.pack ?? "rebalancer");
  const [text, setText] = useState(agent?.strategyText ?? setup?.brief ?? "");
  const [policy, setPolicy] = useState<AgentPolicy>(agent?.policy ?? DEFAULT_POLICY);
  const [draft, setDraft] = useState<StrategyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          agentId: agent?.id ?? null,
          expectedRevision: agent?.revision ?? null,
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
        href={agent ? `/agents/${agent.id}` : "/agents"}
        className="inline-flex w-fit items-center gap-2 rounded-sm text-small text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        Back to {agent ? "agent" : "agents"}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-h1">{agent ? `Edit ${agent.name}` : "New agent"}</h1>
        <p className="max-w-2xl text-body text-fg-muted">
          Describe the strategy. Review its rules and set your limits before saving.
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
                value={pack}
                onChange={(event) => {
                  const parsed = packSchema.safeParse(event.target.value);
                  if (parsed.success) {
                    setPack(parsed.data);
                    invalidate();
                  }
                }}
              >
                {Object.entries(PACKS).map(([value, item]) => (
                  <option key={value} value={value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-small text-fg-muted">{PACKS[pack].description}</p>
            <p className="text-caption text-fg-subtle">
              Supported assets: NEAR, BTC, ETH, SOL, USDC and USDT.
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
                placeholder={EXAMPLES[pack]}
                className="w-full resize-y rounded-sm border border-line bg-surface-2 p-3 text-body leading-relaxed text-fg-strong placeholder:text-fg-subtle"
              />
            </Field>
            <button
              type="button"
              className="w-fit cursor-pointer rounded-sm text-small text-fg-muted underline underline-offset-4 hover:text-fg-strong"
              onClick={() => {
                setText(EXAMPLES[pack]);
                invalidate();
              }}
            >
              Use example
            </button>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-caption text-fg-subtle">Private tier · NEAR AI verified inference</span>
            <Button type="submit" disabled={busy} aria-busy={busy && draft === null}>
              {busy && draft === null ? (
                <LoaderCircle aria-hidden="true" size={16} className="motion-safe:animate-spin" />
              ) : null}
              {busy && draft === null ? "Verifying strategy…" : "Review strategy"}
            </Button>
          </div>
          <p className="text-caption leading-relaxed text-fg-subtle">
            Copy Trading, Yield Optimizer and Meme Hunter are planned separately. Strategies and limits stay
            on this backend; inference is encrypted to an attested model.
          </p>
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
            {draft.strategy.kind === "triggers" &&
            draft.strategy.condition === "buy_above" &&
            policy.approvalMode !== "autonomous" ? (
              <p className="rounded-sm border border-warn/30 bg-warn-soft p-3 text-small text-warn">
                Breakouts require your approval in this mode. They execute automatically only with “Autonomous
                within limits”.
              </p>
            ) : null}
            <PolicyFields
              policy={policy}
              onChange={(next) => {
                setPolicy(next);
                setSaveId(null);
              }}
              disabled={busy}
            />
            <p className="text-caption text-fg-subtle">
              Verified with {draft.model}. Review expires 30 minutes after parsing.
            </p>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy && draft !== null}>
              {busy ? "Saving…" : agent ? "Save new version · paused" : "Create agent · paused"}
            </Button>
          </m.form>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-small text-loss">
          {error}
        </p>
      ) : null}
    </div>
  );
}
