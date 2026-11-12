"use client";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import dynamic from "next/dynamic";
import { type ReactElement, useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAppNetwork } from "@/components/shell/network-context";
import { Badge } from "@/components/ui/badge";
import {
  CHANGE_PERIODS,
  type ChangePeriod,
  type SpotMarketToken,
  spotMarketViewSchema,
  spotMetricsViewSchema,
} from "@/shared/market-pages";
import { MARKET_PAGE_SIZE, MoreMarketRows } from "./more-market-rows";
import { displaySymbol, SpotMarketsTable } from "./spot-markets-table";
import { readTrading } from "./trading-api";

type Network = "near" | "all";

const PILL =
  "h-8 cursor-pointer rounded-full px-3 text-small transition-colors duration-200 ease-ios pointer-coarse:h-11";
const PILL_ON = "bg-surface-3 font-medium text-fg-strong";
const PILL_OFF = "text-fg-muted hover:text-fg-strong";
/** "Major" means a CoinGecko market cap of at least $50M (whole dollars). */
const MAJOR_MARKET_CAP_USD = 50_000_000n;
const EMPTY_TOKENS: readonly SpotMarketToken[] = [];
const SpotTradeDialog = dynamic(() => import("./spot-trade-dialog").then((module) => module.SpotTradeDialog));

function volume(token: SpotMarketToken): bigint {
  return BigInt(token.metrics?.volume24h ?? "0");
}

/** Prefer a NEAR token (payable from the wallet or private balance), then one whose ticker matches the coin's. */
function preference(token: SpotMarketToken): number {
  return (
    (token.blockchain === "near" ? 2 : 0) +
    (token.tokenSymbol.toLowerCase() === token.metrics?.symbol ? 1 : 0)
  );
}

/**
 * One row per major coin with trading volume. 1Click lists the same coin many times (bridges and chains); the
 * preferred token stands for it, and ties keep 1Click's order, which lists each coin's main token first.
 */
function majorTokens(tokens: readonly SpotMarketToken[]): readonly SpotMarketToken[] {
  const picked = new Map<string, SpotMarketToken>();
  for (const token of tokens) {
    const coin = token.metrics?.coinId;
    if (!coin || volume(token) === 0n || BigInt(token.metrics?.marketCap ?? "0") < MAJOR_MARKET_CAP_USD) {
      continue;
    }
    const current = picked.get(coin);
    if (!current || preference(token) > preference(current)) {
      picked.set(coin, token);
    }
  }
  return [...picked.values()];
}

/** Highest 24 h volume first; whole-dollar strings compare exactly as bigint. */
function byVolume(a: SpotMarketToken, b: SpotMarketToken): number {
  const delta = volume(b) - volume(a);
  return delta > 0n ? 1 : delta < 0n ? -1 : a.tokenSymbol.localeCompare(b.tokenSymbol);
}

/**
 * Spot: major coins 1Click can swap, one row each, as a flat table sorted by volume with a Trade button per row.
 * Without CoinGecko's figures every listed token is shown instead.
 */
export function SpotScreen(): ReactElement {
  const appNetwork = useAppNetwork();
  const [search, setSearch] = useState(""),
    [network, setNetwork] = useState<Network>("near"),
    [period, setPeriod] = useState<ChangePeriod>("24h"),
    [limit, setLimit] = useState(MARKET_PAGE_SIZE),
    [target, setTarget] = useState<SpotMarketToken | null>(null);
  const markets = useQuery({
    queryKey: ["spot-markets"],
    queryFn: ({ signal }) => readTrading("/api/trading/spot-markets", spotMarketViewSchema, signal),
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
  const statistics = useQuery({
    queryKey: ["spot-market-metrics"],
    queryFn: ({ signal }) =>
      readTrading("/api/trading/spot-markets?view=metrics", spotMetricsViewSchema, signal),
    staleTime: 300_000,
    refetchInterval: 300_000,
    retry: false,
  });
  const view = markets.data;
  const catalog = view?.tokens ?? EMPTY_TOKENS;
  const tokens = useMemo(() => {
    if (!statistics.data?.metrics.length) {
      return catalog;
    }
    const metrics = new Map(statistics.data.metrics.map((item) => [item.coinId, item]));
    return catalog.map((token) => {
      const entry = token.coinId ? metrics.get(token.coinId) : undefined;
      return entry ? { ...token, metrics: entry } : token;
    });
  }, [catalog, statistics.data]);
  const traded = useMemo(
    () => (statistics.data?.metrics.length ? majorTokens(tokens) : tokens),
    [tokens, statistics.data],
  );
  const needle = useDeferredValue(search.trim().toLowerCase());
  const sorted = useMemo(() => traded.toSorted(byVolume), [traded]);
  const shown = useMemo(
    () =>
      sorted.filter(
        (token) =>
          (network === "all" || token.blockchain === "near") &&
          `${displaySymbol(token)} ${token.tokenSymbol} ${token.metrics?.name ?? ""} ${token.assetId} ${token.blockchain}`
            .toLowerCase()
            .includes(needle),
      ),
    [needle, network, sorted],
  );
  const nearCount = useMemo(() => traded.filter((token) => token.blockchain === "near").length, [traded]);
  const notice =
    markets.isError && view
      ? "Showing the last market prices."
      : (statistics.data?.notice ?? (statistics.isError ? "Market statistics are unavailable." : null));
  const tabs = [
    { id: "near", label: view ? `NEAR ${nearCount}` : "NEAR" },
    { id: "all", label: view ? `All networks ${traded.length}` : "All networks" },
  ] as const;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex items-center gap-3">
        <h1 className="font-display text-page-title">Spot</h1>
        {appNetwork === "testnet" ? <Badge tone="neutral">Mainnet only</Badge> : null}
      </header>
      <section aria-labelledby="spot-markets" className="flex min-w-0 flex-col gap-3">
        <h2 id="spot-markets" className="sr-only">
          Markets
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={network === tab.id}
                  onClick={() => {
                    setNetwork(tab.id);
                    setLimit(MARKET_PAGE_SIZE);
                  }}
                  className={`${PILL} ${network === tab.id ? PILL_ON : PILL_OFF}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <fieldset className="flex items-center gap-0.5 rounded-full bg-sunken p-0.5 ring-1 ring-line-card ring-inset">
              <legend className="sr-only">Price change period</legend>
              {CHANGE_PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  onClick={() => setPeriod(p)}
                  className={`h-7 cursor-pointer rounded-full px-2.5 font-mono text-caption transition-colors duration-200 ease-ios pointer-coarse:h-11 ${period === p ? PILL_ON : PILL_OFF}`}
                >
                  {p}
                </button>
              ))}
            </fieldset>
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
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(MARKET_PAGE_SIZE);
              }}
              placeholder="Search tokens"
              className="w-full min-w-0 bg-transparent text-small text-fg-strong outline-none placeholder:text-fg-subtle"
            />
          </label>
        </div>
        {notice ? (
          <p role="status" className="text-small text-warn">
            {notice}
          </p>
        ) : null}
        {markets.error && !view ? (
          <p role="alert" className="py-6 text-small text-warn">
            {markets.error.message}
          </p>
        ) : view && shown.length === 0 ? (
          <p className="py-6 text-small text-fg-muted">
            {needle ? `No token matches “${search.trim()}”.` : "No major tokens on this network."}
          </p>
        ) : (
          <SpotMarketsTable
            tokens={view ? shown.slice(0, limit) : null}
            period={period}
            onTrade={(target) => {
              if (appNetwork === "testnet") {
                toast.info("Mainnet only. Switch to Mainnet to trade.");
                return;
              }
              setTarget(target);
            }}
          />
        )}
        <MoreMarketRows
          shown={limit}
          total={shown.length}
          onMore={() => setLimit((size) => size + MARKET_PAGE_SIZE)}
        />
      </section>
      {target ? <SpotTradeDialog target={target} tokens={tokens} onClose={() => setTarget(null)} /> : null}
    </div>
  );
}
