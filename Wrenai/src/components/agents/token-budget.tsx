"use client";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadWalletBudgets } from "@/server/chat/draft-actions";
import {
  type AgentBudgetInput,
  budgetTokenAmount,
  MAX_AGENT_BUDGET_DECIMALS,
  nearAccountSchema,
} from "@/shared/agent-budget";

interface TokenBudgetProps {
  readonly value: AgentBudgetInput | null;
  readonly onChange: (value: AgentBudgetInput | null) => void;
  readonly excludeId?: string;
  readonly disabled: boolean;
}

export function TokenBudget({ value, onChange, excludeId, disabled }: TokenBudgetProps): ReactElement {
  const id = useId();
  const [contract, setContract] = useState("");
  const [extra, setExtra] = useState<string | undefined>(value?.assetId);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["wallet-budget", id, excludeId ?? null, extra ?? null],
    queryFn: async () => {
      const result = await loadWalletBudgets({
        ...(excludeId ? { excludeId } : {}),
        ...(extra ? { assetId: extra } : {}),
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const tokens = query.data?.tokens ?? [];
  const selected = tokens.find((token) => token.assetId === value?.assetId);
  function lookup(): void {
    const parsed = nearAccountSchema.safeParse(contract.trim());
    if (!parsed.success) {
      setLookupError("Enter the token's NEAR contract account.");
      return;
    }
    setLookupError(null);
    const asset = `nep141:${parsed.data}`;
    if (extra === asset) {
      void query.refetch();
    } else {
      setExtra(asset);
    }
  }
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-sm border border-line p-4">
      <legend className="px-1 text-small font-medium">Agent budget</legend>
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-fg-muted">
          Choose a held token and amount. No transfer or permission is requested.
        </p>
        <Button
          type="button"
          disabled={query.isFetching || disabled}
          onClick={() => {
            void query.refetch();
          }}
        >
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="text-small text-fg-muted">
          Loading wallet tokens…
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="text-small text-warn">
          {query.error.message}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-2 text-small">
          Budget token
          <select
            value={value?.assetId ?? ""}
            onChange={(event) =>
              onChange(event.target.value ? { assetId: event.target.value, amount: "" } : null)
            }
            className="min-h-11 w-full rounded-sm border border-line bg-surface-1 px-3 text-small"
          >
            <option value="">Allocate later</option>
            {value && !selected ? (
              <option value={value.assetId}>{value.assetId} · balance not verified</option>
            ) : null}
            {tokens.map((token) => (
              <option key={token.assetId} value={token.assetId}>
                {token.symbol} · {token.assetId === "native:near" ? "Native NEAR" : token.assetId.slice(7)}
              </option>
            ))}
          </select>
        </label>
        {value ? (
          <label className="flex min-w-0 flex-col gap-2 text-small">
            Amount {selected ? `· ${selected.symbol}` : ""}
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              required
              value={value.amount}
              onChange={(event) => onChange({ assetId: value.assetId, amount: event.target.value })}
              className="min-h-11 w-full rounded-sm border border-line bg-surface-1 px-3 font-mono text-small tabular-nums"
            />
          </label>
        ) : null}
      </div>
      {selected ? (
        <dl className="grid gap-3 text-caption sm:grid-cols-3">
          {(
            [
              { label: "In wallet", units: selected.balanceUnits },
              { label: "Allocated elsewhere", units: selected.allocatedUnits },
              { label: "Available", units: selected.availableUnits },
            ] as const
          ).map((item) => (
            <div key={item.label} className="min-w-0 space-y-1">
              <dt className="text-fg-muted">{item.label}</dt>
              <dd className="break-all font-mono tabular-nums">
                {budgetTokenAmount(item.units, selected.decimals)} {selected.symbol}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {selected && selected.decimals > MAX_AGENT_BUDGET_DECIMALS ? (
        <p role="alert" className="text-small text-warn">
          This token has more decimal places than agent budgets support.
        </p>
      ) : null}
      {selected?.deficitUnits !== undefined && selected.deficitUnits !== "0" ? (
        <p role="alert" className="text-small text-warn">
          Existing allocations exceed this wallet balance. Reduce them or add funds before allocating more.
        </p>
      ) : null}
      {query.data ? <p className="text-caption text-fg-subtle">{query.data.note}</p> : null}
      {query.data && tokens.length === 0 ? (
        <p className="text-small text-fg-muted">
          No held tokens were found. Fund the wallet or check a token contract.
        </p>
      ) : null}
      <details className="text-caption text-fg-muted">
        <summary className="cursor-pointer py-2">Missing a token?</summary>
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <label className="flex min-w-0 flex-1 flex-col gap-2" htmlFor={`${id}-contract`}>
            NEAR token contract
            <input
              id={`${id}-contract`}
              value={contract}
              onChange={(event) => setContract(event.target.value)}
              type="text"
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  lookup();
                }
              }}
              className="min-h-11 rounded-sm border border-line bg-surface-1 px-3 text-small"
            />
          </label>
          <Button type="button" onClick={lookup} disabled={query.isFetching || disabled}>
            Check token
          </Button>
        </div>
        {lookupError ? (
          <p role="alert" className="pt-2 text-warn">
            {lookupError}
          </p>
        ) : null}
      </details>
      {query.data?.funded.length ? (
        <p className="text-caption text-fg-muted">
          {query.data.funded.length} funded token balance{query.data.funded.length === 1 ? " is" : "s are"}{" "}
          held in trading venues separately from this wallet.
        </p>
      ) : null}
      <p className="text-caption text-fg-subtle">
        Reservations stay until changed or discarded. Wallet spending outside Wrenai can reduce availability.
        Token selection does not guarantee an execution route.
      </p>
    </fieldset>
  );
}
