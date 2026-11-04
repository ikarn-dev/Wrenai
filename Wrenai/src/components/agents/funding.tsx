"use client";
import { type FormEvent, type ReactElement, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToastState } from "@/components/ui/toast";
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
  const [, setMessage] = useToastState("info");
  const [allocated, setAllocated] = useState(false);
  const request = useRef<{ readonly input: string; readonly id: string } | null>(null);
  const quote = preview.quote;
  if (!quote || preview.balance.status !== "verified" || agent.status === "running") {
    return null;
  }
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const values = {
      previewId: preview.id,
      agentCapitalUsd: agent.policy.budgetUsd,
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
      <Button type="submit" disabled={busy || allocated}>
        {busy ? "Allocating…" : allocated ? "Allocated" : "Allocate input balance"}
      </Button>
    </form>
  );
}
