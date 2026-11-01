"use client";

import { type FormEvent, type ReactElement, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { type Notice, NoticeBox } from "@/components/ui/status-line";
import { readAccountRiskPolicy, saveAccountRiskPolicy } from "@/server/guard/risk-actions";
import { type UserRiskPolicyRecord, userRiskPolicySchema } from "@/shared/risk-policy";

export function SpendingLimit({ initial }: { readonly initial: UserRiskPolicyRecord | null }): ReactElement {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef<string | null>(null);
  const [record, setRecord] = useState(initial);
  const [amount, setAmount] = useState(initial?.policy.dailyCapUsd ?? "");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = userRiskPolicySchema.safeParse({ dailyCapUsd: amount });
    if (!parsed.success) {
      setInvalid(true);
      setNotice({ tone: "error", text: parsed.error.issues[0]?.message ?? "Check your spending cap." });
      input.current?.focus();
      return;
    }
    setInvalid(false);
    setNotice(null);
    requestId.current ??= crypto.randomUUID();
    const currentRequest = requestId.current;
    startTransition(async () => {
      try {
        const result = await saveAccountRiskPolicy({
          requestId: currentRequest,
          expectedRevision: record?.revision ?? 0,
          policy: parsed.data,
        });
        if (!result.ok) {
          setConflict(result.code === "conflict");
          setNotice({ tone: "error", text: result.message });
          return;
        }
        setRecord(result.value);
        setAmount(result.value.policy.dailyCapUsd);
        requestId.current = null;
        setConflict(false);
        setNotice({ tone: "info", text: "Spending cap saved. This does not deposit or move funds." });
      } catch {
        setNotice({
          tone: "error",
          text: "Your spending cap could not be saved. Your input is still here; try again.",
        });
      }
    });
  }

  function reload(): void {
    startTransition(async () => {
      try {
        const result = await readAccountRiskPolicy({});
        if (!result.ok) {
          setNotice({ tone: "error", text: result.message });
          return;
        }
        setRecord(result.value);
        setAmount(result.value?.policy.dailyCapUsd ?? "");
        setConflict(false);
        setInvalid(false);
        requestId.current = null;
        setNotice({ tone: "info", text: "Latest saved cap loaded. Review it before making changes." });
      } catch {
        setNotice({ tone: "error", text: "The latest cap could not be loaded. Try again shortly." });
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" aria-busy={busy}>
      <div className="flex max-w-sm flex-col gap-2">
        <label htmlFor={id} className="text-small font-medium text-fg">
          Daily spending cap (USD)
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={16}
          placeholder="100.00"
          value={amount}
          disabled={busy}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint ${id}-status`}
          className="h-11 min-w-0 rounded-sm border border-line-strong bg-surface-1 px-3 font-mono text-body tabular-nums text-fg-strong placeholder:text-fg-subtle disabled:opacity-60"
          onChange={(event) => {
            setAmount(event.target.value);
            setInvalid(false);
            setNotice(null);
            requestId.current = null;
          }}
        />
        <p id={`${id}-hint`} className="text-small text-fg-subtle">
          Shared across all agents over a rolling 24 hours. Agent budgets and trade limits still apply.
        </p>
      </div>
      <div id={`${id}-status`} aria-live="polite">
        {notice === null ? null : <NoticeBox notice={notice} />}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy || conflict} aria-busy={busy}>
          {busy ? "Please wait…" : "Save cap"}
        </Button>
        {conflict ? (
          <Button onClick={reload} disabled={busy}>
            Load latest cap
          </Button>
        ) : null}
        {record === null ? <p className="text-small text-fg-subtle">No account-wide cap saved yet.</p> : null}
      </div>
    </form>
  );
}
