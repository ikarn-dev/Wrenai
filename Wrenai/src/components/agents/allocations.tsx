"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useRef } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { Button } from "@/components/ui/button";
import { changeAgentAllocation, loadAgentAllocations } from "@/server/positions/allocation-actions";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { AgentAllocation, AgentAllocationView } from "@/shared/allocation";
import { parseTokenAmount } from "@/shared/token-units";

function AllocationRow({
  item,
  view,
  onChanged,
}: {
  readonly item: AgentAllocation;
  readonly view: AgentAllocationView;
  readonly onChanged: () => Promise<void>;
}): ReactElement {
  const request = useRef<{ input: string; id: string } | null>(null);
  const change = useMutation({
    mutationFn: async (values: { amount: string; target: string }) => {
      const input = {
        agentId: view.agentId,
        expectedRevision: view.revision,
        scope: item.scope,
        assetId: item.assetId,
        quantityUnits: parseTokenAmount(values.amount, item.decimals).toString(),
        targetAgentId: values.target || null,
      };
      const hash = JSON.stringify(input);
      if (request.current?.input !== hash) {
        request.current = { input: hash, id: crypto.randomUUID() };
      }
      const result = await changeAgentAllocation({ ...input, requestId: request.current.id });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    onSuccess: onChanged,
  });
  const targets =
    item.scope === "confidential" ? view.targets.filter((target) => target.assetId === item.assetId) : [];
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    change.mutate({ amount: String(data.get("amount") ?? ""), target: String(data.get("target") ?? "") });
  }
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 border-t border-line py-4 first:border-0 first:pt-0"
    >
      <div className="flex flex-wrap justify-between gap-2 text-small">
        <span>
          {item.symbol} · {item.scope === "confidential" ? "Private balance" : "Public Intents"}
        </span>
        <span className="font-mono tabular-nums">
          {budgetTokenAmount(item.availableUnits, item.decimals)} available
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">
          <span className="text-fg-muted">Amount</span>
          <input
            name="amount"
            required
            inputMode="decimal"
            defaultValue={budgetTokenAmount(item.availableUnits, item.decimals)}
            disabled={view.running || change.isPending || item.availableUnits === "0"}
            className="min-h-11 rounded-sm border border-line bg-surface-2 px-3 font-mono tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          <span className="text-fg-muted">Destination</span>
          <select
            name="target"
            disabled={view.running || change.isPending}
            className="min-h-11 rounded-sm border border-line bg-surface-2 px-3"
          >
            <option value="">Available balance</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={view.running || change.isPending || item.availableUnits === "0"}>
          {change.isPending ? "Updating…" : "Move allocation"}
        </Button>
      </div>
      {change.error ? (
        <p role="alert" className="text-small text-loss">
          {change.error.message}
        </p>
      ) : null}
    </form>
  );
}
export function AgentAllocations({
  agentId,
  ownerId,
}: {
  readonly agentId: string;
  readonly ownerId: string;
}): ReactElement {
  const cache = useQueryClient(),
    key = ["agent-allocations", ownerId, agentId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await loadAgentAllocations({ agentId });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    staleTime: 5000,
    retry: false,
  });
  async function changed(): Promise<void> {
    await cache.invalidateQueries({ queryKey: ["agent-allocations", ownerId] });
  }
  return (
    <PortfolioPanel id="agent-allocations" title="Allocated funds">
      <p className="text-caption text-fg-muted">
        Release unused funds or assign them to a paused agent using the same token. This moves allocation
        ownership; it does not send tokens on-chain.
      </p>
      {query.isPending ? (
        <p role="status" className="text-small text-fg-muted">
          Loading allocations…
        </p>
      ) : query.error ? (
        <div className="space-y-3">
          <p role="alert" className="text-small text-loss">
            {query.error.message}
          </p>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : query.data.allocations.length ? (
        query.data.allocations.map((item) => (
          <AllocationRow
            key={`${item.scope}:${item.assetId}:${item.availableUnits}`}
            item={item}
            view={query.data}
            onChanged={changed}
          />
        ))
      ) : (
        <p className="text-small text-fg-muted">
          No private or public Intents funds are allocated. Return venue funds before releasing them.
        </p>
      )}
      {query.data?.running ? (
        <p className="text-caption text-fg-subtle">Pause this agent before changing its allocation.</p>
      ) : null}
    </PortfolioPanel>
  );
}
