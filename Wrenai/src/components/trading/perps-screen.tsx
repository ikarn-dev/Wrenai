"use client";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import dynamic from "next/dynamic";
import { type ReactElement, useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useAppNetwork } from "@/components/shell/network-context";
import { Badge } from "@/components/ui/badge";
import { type PerpsMarketRow, perpsMarketRowSchema } from "@/shared/market-pages";
import { MARKET_PAGE_SIZE, MoreMarketRows } from "./more-market-rows";
import { PerpsMarketsTable } from "./perps-markets-table";
import { readTrading } from "./trading-api";
import { usePerpsMarks } from "./use-perps-marks";

const PERPS_ROWS = z.array(perpsMarketRowSchema).max(2000);
const PerpsTradeDialog = dynamic(() =>
  import("./perps-trade-dialog").then((module) => module.PerpsTradeDialog),
);
const PerpsAccount = dynamic(() => import("./perps-account").then((module) => module.PerpsAccount));
type Tab = "markets" | "account";

const PILL =
  "h-8 cursor-pointer rounded-full px-3 text-small transition-colors duration-200 ease-ios pointer-coarse:h-11";

function byVolume(a: PerpsMarketRow, b: PerpsMarketRow): number {
  const delta = BigInt(b.volume24h) - BigInt(a.volume24h);
  return delta > 0n ? 1 : delta < 0n ? -1 : a.name.localeCompare(b.name);
}

/**
 * Perps: every Hyperliquid market as one flat table sorted by volume, with a Trade button per row that opens the
 * order ticket in a dialog (like Spot and Memecoins). The Account tab holds margin, positions and transfers.
 */
export function PerpsScreen({ accountId }: { readonly accountId: string }): ReactElement {
  const appNetwork = useAppNetwork();
  const [tab, setTab] = useState<Tab>("markets"),
    [search, setSearch] = useState(""),
    [limit, setLimit] = useState(MARKET_PAGE_SIZE),
    [target, setTarget] = useState<PerpsMarketRow | null>(null);
  const marks = usePerpsMarks(tab === "markets");
  const query = useQuery({
    queryKey: ["perps-markets"],
    queryFn: ({ signal }) => readTrading("/api/trading/perps-markets", PERPS_ROWS, signal),
    staleTime: 5000,
    refetchInterval: 10000,
    enabled: tab === "markets",
    retry: false,
  });
  const rows = query.data;
  const needle = useDeferredValue(search.trim().toLowerCase());
  const traded = useMemo(() => rows?.filter((row) => row.volume24h !== "0").sort(byVolume), [rows]);
  const shown = useMemo(
    () => traded?.filter((row) => row.name.toLowerCase().includes(needle)) ?? null,
    [traded, needle],
  );
  // The dialog follows the latest prices while it stays open on the same market.
  const live = target ? (rows?.find((r) => r.name === target.name) ?? target) : null;
  const tabs = [
    { id: "markets", label: traded ? `Markets ${traded.length}` : "Markets" },
    { id: "account", label: "Account" },
  ] as const;
  const feed = marks ? "Live marks" : query.isError ? "Last snapshot" : "Snapshot prices";

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex items-center gap-3">
        <h1 className="font-display text-page-title">Perps</h1>
        {appNetwork === "testnet" ? <Badge tone="neutral">Mainnet only</Badge> : null}
      </header>
      <section aria-labelledby="perps-view" className="flex min-w-0 flex-col gap-3">
        <h2 id="perps-view" className="sr-only">
          {tab === "markets" ? "Markets" : "Account"}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => {
                  if (t.id === "account" && appNetwork === "testnet") {
                    toast.info("Perps accounts are Mainnet only.");
                    return;
                  }
                  setTab(t.id);
                }}
                className={`${PILL} ${tab === t.id ? "bg-surface-3 font-medium text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
              >
                {t.label}
              </button>
            ))}
            {tab === "markets" && rows ? (
              <span className="ml-2 whitespace-nowrap text-caption text-fg-subtle">{feed}</span>
            ) : null}
          </div>
          {tab === "markets" ? (
            <label className="flex h-9 w-full max-w-64 items-center gap-2 rounded-full bg-sunken px-3 ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent pointer-coarse:h-11">
              <Search
                aria-hidden="true"
                size={14}
                strokeWidth={1.75}
                absoluteStrokeWidth
                className="text-fg-subtle"
              />
              <span className="sr-only">Search markets</span>
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(MARKET_PAGE_SIZE);
                }}
                placeholder="Search markets"
                className="w-full min-w-0 bg-transparent text-small text-fg-strong outline-none placeholder:text-fg-subtle"
              />
            </label>
          ) : null}
        </div>
        {tab === "account" ? (
          <PerpsAccount accountId={accountId} />
        ) : query.error && !rows ? (
          <p role="alert" className="py-6 text-small text-warn">
            {query.error.message}
          </p>
        ) : shown && shown.length === 0 ? (
          <p className="py-6 text-small text-fg-muted">No market matches “{search.trim()}”.</p>
        ) : (
          <PerpsMarketsTable
            rows={shown?.slice(0, limit) ?? null}
            marks={marks}
            onTrade={(target) => {
              if (appNetwork === "testnet") {
                toast.info("Mainnet only. Switch to Mainnet to trade.");
                return;
              }
              setTarget(target);
            }}
          />
        )}
        {tab === "markets" ? (
          <MoreMarketRows
            shown={limit}
            total={shown?.length ?? 0}
            onMore={() => setLimit((size) => size + MARKET_PAGE_SIZE)}
          />
        ) : null}
      </section>
      {live ? <PerpsTradeDialog target={live} onClose={() => setTarget(null)} /> : null}
    </div>
  );
}
