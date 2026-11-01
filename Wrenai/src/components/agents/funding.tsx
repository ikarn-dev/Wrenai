"use client";
import { type FormEvent, type ReactElement, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { allocateAgentBalance } from "@/server/engine/funding-actions";
import type { AgentSummary } from "@/shared/agents";
import { formatUnits } from "@/shared/money";
import type { TradePreview } from "@/shared/trade-preview";

export function AgentFunding({
  agent,
  preview,
}: {
  readonly agent: AgentSummary;
  readonly preview: TradePreview;
}): ReactElement | null {
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [allocated, setAllocated] = useState(false);
  const request = useRef<{ readonly input: string; readonly id: string } | null>(null);
  const quote = preview.quote;
  if (!quote || preview.balance.status !== "verified" || agent.status === "running") {
    return null;
  }
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = {
      previewId: preview.id,
      sharedCapitalUsd: String(data.get("sharedCapitalUsd") ?? ""),
      agentCapitalUsd: String(data.get("agentCapitalUsd") ?? ""),
    };
    const input = JSON.stringify(values);
    if (request.current?.input !== input) {
      request.current = { input, id: crypto.randomUUID() };
    }
    const requestId = request.current.id;
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await allocateAgentBalance({ ...values, requestId });
        if (result.ok) {
          setAllocated(true);
        }
        setMessage(result.ok ? "Balance allocated. No funds were transferred." : result.message);
      } catch {
        setMessage("The allocation could not be confirmed. Retry with the same request.");
      }
    });
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-sm border border-line p-4">
      <div className="space-y-1">
        <h3 className="text-small font-medium">Trading allocation</h3>
        <p className="text-caption text-fg-muted">
          Assign{" "}
          <span className="break-all font-mono tabular-nums">
            {formatUnits(BigInt(quote.inputUnits), {
              decimals: preview.input.decimals,
              fractionDigits: preview.input.decimals,
            }).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")}
          </span>{" "}
          {preview.input.tokenSymbol} from this preview to this agent.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            { name: "sharedCapitalUsd", label: "Total capital limit · USD" },
            { name: "agentCapitalUsd", label: "This agent’s limit · USD" },
          ] as const
        ).map((field) => (
          <label key={field.name} className="flex flex-col gap-2 text-small">
            <span>{field.label}</span>
            <input
              name={field.name}
              type="text"
              inputMode="decimal"
              required
              defaultValue={agent.policy.budgetUsd}
              disabled={busy || allocated}
              className="min-h-11 w-full rounded-sm border border-line bg-surface-2 px-3 font-mono text-small"
            />
          </label>
        ))}
      </div>
      <Button type="submit" disabled={busy || allocated}>
        {busy ? "Allocating…" : allocated ? "Allocated" : "Allocate input balance"}
      </Button>
      {message ? (
        <p role="status" className="text-small text-fg-muted">
          {message}
        </p>
      ) : null}
    </form>
  );
}
