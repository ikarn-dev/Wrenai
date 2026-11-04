"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { type ReactElement, useState } from "react";
import {
  type MemecoinRow,
  type MemecoinSort,
  memecoinViewSchema,
  type SpotMarketToken,
  spotMarketViewSchema,
} from "@/shared/market-pages";
import { MemecoinsTable } from "./memecoins-table";
import { SpotTradeDialog } from "./spot-trade-dialog";
import { readTrading } from "./trading-api";

const SORTS: readonly { readonly id: MemecoinSort; readonly label: string }[] = [
  { id: "mcap", label: "Market cap" },
  { id: "volume", label: "Volume" },
  { id: "change", label: "Gainers" },
  { id: "age", label: "New" },
];
const PILL =
  "h-8 cursor-pointer rounded-full px-3 text-small transition-colors duration-200 ease-ios pointer-coarse:h-11";

/**
 * Memecoins on NEAR from Squint's coin index, one sort at a time. Coins NEAR Intents lists open the Spot trade
 * dialog; the rest link to their Squint report.
 */
export function MemecoinsScreen(): ReactElement {
  const [sort, setSort] = useState<MemecoinSort>("mcap"),
    [search, setSearch] = useState(""),
    [target, setTarget] = useState<SpotMarketToken | null>(null);
  const coins = useQuery({
    queryKey: ["memecoins", sort],
    queryFn: ({ signal }) => readTrading(`/api/trading/memecoins?sort=${sort}`, memecoinViewSchema, signal),
    staleTime: 15000,
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  // The trade dialog's private-balance pay list. Shares the Spot page's cache; loaded up front so the dialog's
  // default pay token exists when it opens.
  const registry = useQuery({
    queryKey: ["spot-markets"],
    queryFn: ({ signal }) => readTrading("/api/trading/spot-markets", spotMarketViewSchema, signal),
    staleTime: 15000,
    retry: false,
  });
  const needle = search.trim().toLowerCase();
  const rows = coins.data
    ? coins.data.coins.filter((c) => `${c.symbol} ${c.name} ${c.token}`.toLowerCase().includes(needle))
    : null;

  function trade(coin: MemecoinRow): void {
    if (coin.asset) {
      setTarget(coin.asset);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Memecoins</h1>
      <section aria-labelledby="memecoins" className="flex min-w-0 flex-col gap-3">
        <h2 id="memecoins" className="sr-only">
          Memecoins
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {SORTS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={sort === option.id}
                onClick={() => setSort(option.id)}
                className={`${PILL} ${sort === option.id ? "bg-surface-3 font-medium text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="flex h-9 w-full max-w-64 items-center gap-2 rounded-full bg-sunken px-3 ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent pointer-coarse:h-11">
            <Search
              aria-hidden="true"
              size={14}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className="text-fg-subtle"
            />
            <span className="sr-only">Search memecoins</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memecoins"
              className="w-full min-w-0 bg-transparent text-small text-fg-strong outline-none placeholder:text-fg-subtle"
            />
          </label>
        </div>
        {coins.error && !coins.data ? (
          <p role="alert" className="py-6 text-small text-warn">
            {coins.error.message}
          </p>
        ) : rows && rows.length === 0 ? (
          <p className="py-6 text-small text-fg-muted">
            {needle ? `No memecoin matches “${search.trim()}”.` : "No memecoins listed right now."}
          </p>
        ) : (
          <MemecoinsTable coins={rows} now={coins.dataUpdatedAt} onTrade={trade} />
        )}
      </section>
      <SpotTradeDialog target={target} tokens={registry.data?.tokens ?? []} onClose={() => setTarget(null)} />
    </div>
  );
}
