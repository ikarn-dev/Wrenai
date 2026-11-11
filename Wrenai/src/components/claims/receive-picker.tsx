"use client";

import { useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { TokenIcon } from "@/components/trading/token-icon";
import { readTrading } from "@/components/trading/trading-api";
import { type ReceiveOption, WNEAR_ASSET_ID } from "@/shared/claims";
import { spotMarketViewSchema, spotMetricsViewSchema } from "@/shared/market-pages";

/** "held" keeps each token as the agent holds it; "near" pays wNEAR and unwraps it to native NEAR in the wallet. */
export type ReceiveChoice = "held" | "near" | string;

interface Choice {
  readonly key: ReceiveChoice;
  readonly label: string;
  readonly detail: string;
  /** The token whose icon marks the row; null for "As held". */
  readonly assetId: string | null;
}

function choices(options: readonly ReceiveOption[], held: boolean): Choice[] {
  return [
    {
      key: "near",
      label: "NEAR",
      detail: "Arrives as wNEAR; one approval unwraps it",
      assetId: WNEAR_ASSET_ID,
    },
    ...(held
      ? [{ key: "held", label: "As held", detail: "Each token as the agent holds it", assetId: null }]
      : []),
    ...options.map((option) => ({
      key: option.assetId,
      label: option.symbol,
      detail: option.assetId === WNEAR_ASSET_ID ? "Wrapped NEAR" : option.assetId.replace(/^nep141:/, ""),
      assetId: option.assetId,
    })),
  ];
}

/**
 * Token icons by asset, from the Spot screen's shared catalog and CoinGecko metrics queries. Rows show a letter mark
 * until they arrive, so the list never waits for them.
 */
function useTokenIcons(): ReadonlyMap<string, string> {
  const catalog = useQuery({
    queryKey: ["spot-markets"],
    queryFn: ({ signal }) => readTrading("/api/trading/spot-markets", spotMarketViewSchema, signal),
    staleTime: 15_000,
    retry: false,
  });
  const metrics = useQuery({
    queryKey: ["spot-market-metrics"],
    queryFn: ({ signal }) =>
      readTrading("/api/trading/spot-markets?view=metrics", spotMetricsViewSchema, signal),
    staleTime: 300_000,
    retry: false,
  });
  return useMemo(() => {
    const byCoin = new Map(
      (metrics.data?.metrics ?? []).flatMap((m) => (m.icon ? [[m.coinId, m.icon]] : [])),
    );
    return new Map(
      (catalog.data?.tokens ?? []).flatMap((token) => {
        const icon = token.coinId ? byCoin.get(token.coinId) : undefined;
        return icon ? [[token.assetId, icon]] : [];
      }),
    );
  }, [catalog.data, metrics.data]);
}

/** The token a claim pays out in: every NEAR token 1Click can deliver to the wallet, with a filter. */
export function ReceivePicker({
  options,
  held,
  value,
  onChange,
  disabled,
}: {
  readonly options: readonly ReceiveOption[];
  readonly held: boolean;
  readonly value: ReceiveChoice;
  readonly onChange: (choice: ReceiveChoice) => void;
  readonly disabled: boolean;
}): ReactElement {
  const name = useId(),
    filterId = useId();
  const [filter, setFilter] = useState("");
  const icons = useTokenIcons();
  const query = filter.trim().toLowerCase();
  const all = choices(options, held);
  const shown = query
    ? all.filter((c) => c.key === value || `${c.label} ${c.detail}`.toLowerCase().includes(query))
    : all;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-small text-fg-subtle">Receive as</legend>
      {all.length > 8 ? (
        <label
          htmlFor={filterId}
          className="flex items-center gap-2 rounded-sm bg-sunken px-3 ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent"
        >
          <Search
            aria-hidden="true"
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            className="text-fg-subtle"
          />
          <span className="sr-only">Find a token</span>
          <input
            id={filterId}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a token"
            autoComplete="off"
            className="h-10 w-full min-w-0 bg-transparent text-body text-fg-strong outline-none placeholder:text-fg-subtle pointer-coarse:h-11"
          />
        </label>
      ) : null}
      <div
        data-lenis-prevent
        className="flex max-h-60 flex-col overflow-y-auto overscroll-contain rounded-sm ring-1 ring-line-card ring-inset"
      >
        {shown.map((choice) => (
          <label
            key={choice.key}
            className={`flex cursor-pointer items-center gap-3 border-b border-line-card px-3 py-2.5 last:border-b-0 transition-[background-color,scale] duration-200 ease-ios active:scale-99 motion-reduce:active:scale-100 ${choice.key === value ? "bg-surface-3" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={choice.key}
              checked={choice.key === value}
              onChange={() => onChange(choice.key)}
              className="size-4 shrink-0 accent-accent"
            />
            {choice.assetId === null ? (
              <Layers
                aria-hidden="true"
                size={24}
                strokeWidth={1.75}
                absoluteStrokeWidth
                className="shrink-0 text-fg-muted"
              />
            ) : (
              <TokenIcon symbol={choice.label} icon={icons.get(choice.assetId) ?? null} size={24} />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-medium text-fg-strong">{choice.label}</span>
              <span className="truncate text-caption text-fg-muted">{choice.detail}</span>
            </span>
          </label>
        ))}
        {shown.length === 0 ? <p className="px-3 py-4 text-small text-fg-muted">No token matches.</p> : null}
      </div>
    </fieldset>
  );
}
