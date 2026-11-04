"use client";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { type ReactElement, useState } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { getSpotMarkets, getSpotTokenIcons } from "@/server/manual-trading/actions";
import type { SpotMarketToken } from "@/shared/market-pages";
import { SpotMarketsTable } from "./spot-markets-table";
import { SpotTradeDialog } from "./spot-trade-dialog";
import { TradingHistory } from "./trading-history";

type Network = "near" | "all";

/** NEAR tokens first (they can be paid straight from the wallet), then by symbol. */
function byNetworkThenSymbol(a: SpotMarketToken, b: SpotMarketToken): number {
  const near = Number(b.blockchain === "near") - Number(a.blockchain === "near");
  return near !== 0 ? near : a.tokenSymbol.localeCompare(b.tokenSymbol);
}

/**
 * Spot: every token 1Click can swap, as one flat table with a Trade button per row. Trading opens a dialog that
 * pays from the wallet or the private balance.
 */
export function SpotScreen({ accountId }: { readonly accountId: string }): ReactElement {
  const [search, setSearch] = useState(""),
    [network, setNetwork] = useState<Network>("near"),
    [target, setTarget] = useState<SpotMarketToken | null>(null);
  const markets = useQuery({
    queryKey: ["spot-markets"],
    queryFn: async () => {
      const r = await getSpotMarkets();
      if (!r.ok) {
        throw new Error(r.message);
      }
      return r.value;
    },
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
  // Icons rarely change; one read per session keeps them out of the 30-second price refresh.
  const icons = useQuery({
    queryKey: ["spot-token-icons"],
    queryFn: async () => {
      const r = await getSpotTokenIcons();
      return r.ok ? r.value : {};
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const tokens = markets.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = tokens
    .filter((t) => network === "all" || t.blockchain === "near")
    .filter((t) => `${t.tokenSymbol} ${t.assetId} ${t.blockchain}`.toLowerCase().includes(needle))
    .toSorted(byNetworkThenSymbol);
  const nearCount = tokens.filter((t) => t.blockchain === "near").length;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-page-title">Spot</h1>
        <p className="text-small text-fg-muted">Swap any token NEAR Intents supports.</p>
      </header>
      <section aria-labelledby="spot-markets" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <h2 id="spot-markets" className="sr-only">
              Markets
            </h2>
            {(
              [
                { id: "near", label: `NEAR ${nearCount ? nearCount : ""}` },
                { id: "all", label: `All networks ${tokens.length ? tokens.length : ""}` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={network === tab.id}
                onClick={() => setNetwork(tab.id)}
                className={`h-8 cursor-pointer rounded-full px-3 text-small transition-colors duration-200 ease-ios pointer-coarse:h-11 ${network === tab.id ? "bg-surface-3 font-medium text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
              >
                {tab.label.trim()}
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
            <span className="sr-only">Search tokens</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tokens"
              className="w-full min-w-0 bg-transparent text-small text-fg-strong outline-none placeholder:text-fg-subtle"
            />
          </label>
        </div>
        {markets.isPending ? (
          <div className="flex justify-center py-10">
            <ActivityIndicator size={20} label="Loading markets" />
          </div>
        ) : markets.error ? (
          <p role="alert" className="py-6 text-small text-warn">
            {markets.error.message}
          </p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-small text-fg-muted">No token matches “{search.trim()}”.</p>
        ) : (
          <SpotMarketsTable
            tokens={shown}
            icons={icons.data ?? {}}
            observedAt={markets.dataUpdatedAt}
            onTrade={setTarget}
          />
        )}
      </section>
      <TradingHistory accountId={accountId} kind="spot" />
      <SpotTradeDialog
        target={target}
        tokens={tokens}
        icons={icons.data ?? {}}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
