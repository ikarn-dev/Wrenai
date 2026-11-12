"use client";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import type { z } from "zod";
import { readTrading } from "@/components/trading/trading-api";
import {
  type AgentBudgetInput,
  budgetTokenAmount,
  MAX_AGENT_BUDGET_DECIMALS,
  nearAccountSchema,
  walletBudgetViewSchema,
} from "@/shared/agent-budget";
import { shortTokenAmount } from "@/shared/money";
import { middleTruncate } from "@/shared/truncate";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";
import { INPUT_CLASS, Select } from "./policy-fields";

type BudgetToken = z.infer<typeof walletBudgetViewSchema>["tokens"][number];

/** The name a wallet token shows by: native NEAR and wNEAR are told apart. */
export function budgetTokenSymbol(token: Pick<BudgetToken, "assetId" | "symbol">): string {
  return token.assetId === WALLET_SWAP_NATIVE_OUTPUT
    ? "NEAR"
    : token.assetId === WALLET_SWAP_INPUT
      ? "wNEAR"
      : token.symbol;
}

/**
 * The wallet's budget tokens with what other budgets already reserve. One shared query, so the create dialog can read
 * the same list to set a budget from the instructions without a second wallet read.
 */
export function useWalletBudget(excludeId?: string, extra?: string) {
  return useQuery({
    queryKey: ["wallet-budget", excludeId ?? null, extra ?? null],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        ...(excludeId ? { excludeId } : {}),
        ...(extra ? { assetId: extra } : {}),
      });
      return readTrading(`/api/agents/budget?${params}`, walletBudgetViewSchema, signal);
    },
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

interface TokenBudgetProps {
  readonly label?: string;
  readonly value: AgentBudgetInput | null;
  readonly onChange: (value: AgentBudgetInput | null) => void;
  readonly excludeId?: string;
  readonly disabled: boolean;
}

const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const LINK =
  "cursor-pointer rounded-xs text-caption text-fg-muted underline-offset-4 transition-colors duration-200 ease-ios hover:text-fg-strong hover:underline disabled:cursor-not-allowed disabled:text-fg-disabled";

/**
 * The agent's budget on one row: a held token and an exact amount, with what is still available under it. The
 * full wallet and reservation note sits in the available line's tooltip. A token outside the list can be checked
 * by its contract.
 */
export function TokenBudget({
  label = "Budget",
  value,
  onChange,
  excludeId,
  disabled,
}: TokenBudgetProps): ReactElement {
  const id = useId();
  const [contract, setContract] = useState("");
  const [adding, setAdding] = useState(false);
  // A budget set from the instructions may name a token the default list doesn't include; look it up too.
  const [extra, setExtra] = useState<string | undefined>(value?.assetId);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const query = useWalletBudget(excludeId, extra);
  const tokens = query.data?.tokens ?? [];
  const selected = tokens.find((token) => token.assetId === value?.assetId);
  const symbol = budgetTokenSymbol;

  function lookup(): void {
    const parsed = nearAccountSchema.safeParse(contract.trim());
    if (!parsed.success) {
      setLookupError("Enter the token's NEAR contract, such as usdt.tether-token.near.");
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

  function status(): ReactElement | string {
    if (query.isPending) {
      return "Loading wallet tokens…";
    }
    if (query.error) {
      return <span className="text-warn">{query.error.message}</span>;
    }
    if (tokens.length === 0) {
      return "No tokens found in this wallet.";
    }
    if (!selected) {
      return value ? "Balance not verified. Refresh to check it." : "No budget. You can allocate one later.";
    }
    return (
      <span title={query.data?.note}>
        Available{" "}
        <span className="font-mono tabular-nums text-fg">
          {shortTokenAmount(selected.availableUnits, selected.decimals)} {symbol(selected)}
        </span>
      </span>
    );
  }

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-1.5">
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center justify-between gap-3">
        <span aria-hidden="true" className="text-small text-fg-muted">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="Refresh wallet balances"
          title="Refresh wallet balances"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong disabled:cursor-default pointer-coarse:size-11"
        >
          <RefreshCw {...ICON} className={query.isFetching ? "motion-safe:animate-spin" : ""} />
        </button>
      </div>
      <div className="flex min-w-0 gap-2">
        <Select
          aria-label="Budget token"
          className="flex-1"
          value={value?.assetId ?? ""}
          onChange={(event) =>
            onChange(event.target.value ? { assetId: event.target.value, amount: "" } : null)
          }
        >
          <option value="">No budget yet</option>
          {value && !selected ? (
            <option value={value.assetId}>{value.assetId.replace(/^nep141:/, "")}</option>
          ) : null}
          {tokens.map((token) => {
            const name =
              token.assetId !== WALLET_SWAP_NATIVE_OUTPUT &&
              tokens.some((other) => other.assetId !== token.assetId && symbol(other) === symbol(token))
                ? `${symbol(token)} · ${middleTruncate(token.assetId.slice(7), 10, 8)}`
                : symbol(token);
            return (
              <option key={token.assetId} value={token.assetId}>
                {`${name} — ${shortTokenAmount(token.availableUnits, token.decimals)} available`}
              </option>
            );
          })}
        </Select>
        {value ? (
          <span className="relative w-36 shrink-0">
            <input
              aria-label={`Amount${selected ? ` in ${symbol(selected)}` : ""}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              required
              value={value.amount}
              onChange={(event) => onChange({ assetId: value.assetId, amount: event.target.value })}
              className={`${INPUT_CLASS} font-mono tabular-nums ${selected ? "pr-12" : ""}`}
            />
            {selected && selected.availableUnits !== "0" ? (
              <button
                type="button"
                onClick={() =>
                  onChange({
                    assetId: value.assetId,
                    amount: budgetTokenAmount(selected.availableUnits, selected.decimals),
                  })
                }
                className="absolute top-1/2 right-1.5 h-7 -translate-y-1/2 cursor-pointer rounded-xs px-2 text-caption font-medium text-accent-text transition-colors duration-200 ease-ios hover:bg-surface-3"
              >
                Max
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-lh items-baseline justify-between gap-3 text-caption text-fg-subtle">
        <span role="status" className="min-w-0 truncate">
          {status()}
        </span>
        <button
          type="button"
          aria-expanded={adding}
          aria-controls={adding ? `${id}-token-lookup` : undefined}
          onClick={() => setAdding(!adding)}
          className={`${LINK} shrink-0`}
        >
          {adding ? "Hide token lookup" : "Look up by contract"}
        </button>
      </div>
      {selected && selected.decimals > MAX_AGENT_BUDGET_DECIMALS ? (
        <p role="alert" className="text-caption text-warn">
          This token has more decimals than agent budgets support.
        </p>
      ) : null}
      {selected && selected.deficitUnits !== "0" ? (
        <p role="alert" className="text-caption text-warn">
          Existing budgets exceed this balance. Reduce them or add funds first.
        </p>
      ) : null}
      {adding ? (
        <div id={`${id}-token-lookup`} className="flex flex-col gap-1.5 pt-1">
          <div className="flex gap-2">
            <input
              aria-label="NEAR token contract"
              placeholder="Token contract, such as usdt.tether-token.near"
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
              className={`${INPUT_CLASS} flex-1 font-mono text-small`}
            />
            <button
              type="button"
              onClick={lookup}
              disabled={query.isFetching}
              className="h-9 shrink-0 cursor-pointer rounded-sm bg-surface-3 px-3 text-small font-medium text-fg-strong transition-colors duration-200 ease-ios hover:bg-surface-4 disabled:cursor-not-allowed disabled:text-fg-disabled pointer-coarse:h-11"
            >
              Check
            </button>
          </div>
          {lookupError ? (
            <p role="alert" className="text-caption text-warn">
              {lookupError}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
