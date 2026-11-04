"use client";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getPerpsMarkets, requestManualQuote } from "@/server/manual-trading/actions";
import type { ManualPreview } from "@/shared/manual-trading";
import { formatUnits } from "@/shared/money";
import { decimalDisplay } from "@/shared/trading-display";
import { TRADING_INPUT } from "./fields";
import { MarketChart } from "./market-chart";
import { TradeCard } from "./trade-card";
import { TradingAccount } from "./trading-account";
import { TradingHistory, useManualAccount } from "./trading-history";

function PerpsTicket({ market }: { readonly market: string }): ReactElement {
  const [side, setSide] = useState<"long" | "short">("long"),
    [action, setAction] = useState("open"),
    [quote, setQuote] = useState<ManualPreview | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      const result = await requestManualQuote({
        requestId: crypto.randomUUID(),
        source: "perps",
        intent: {
          kind: "perps",
          market,
          side,
          action,
          quantity: String(data.get("quantity") ?? ""),
          leverage: Number(data.get("leverage")),
          maximumMarginUsd: String(data.get("margin") ?? ""),
          stopLossPrice: String(data.get("stop") ?? "") || null,
          takeProfitPrice: String(data.get("target") ?? "") || null,
          trailingStopBps: data.get("trailing") ? Number(data.get("trailing")) : null,
          slippageBps: Number(data.get("slippage")),
          maximumFeeBps: 10,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setQuote(result.value);
    });
  }
  return (
    <div className="min-w-0 space-y-5">
      <form
        onSubmit={submit}
        onChange={() => setQuote(null)}
        aria-busy={busy}
        className="space-y-4 rounded-lg border border-line-card bg-surface-card p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lead font-medium">Trade {market}</h2>
          <Link
            href={`/agents/new?tool=perps&brief=${encodeURIComponent(`Trade ${market} perpetuals with explicit entry, size, leverage, take-profit and stop-loss rules.`)}`}
            className="text-small text-accent-text"
          >
            Create agent
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-2 text-small text-fg-muted">
            Action
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setQuote(null);
              }}
              className={TRADING_INPUT}
            >
              <option value="open">Open</option>
              <option value="reduce">Reduce</option>
              <option value="close">Close</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-small text-fg-muted">
            Side
            <select
              value={side}
              onChange={(e) => {
                setSide(e.target.value === "short" ? "short" : "long");
                setQuote(null);
              }}
              className={TRADING_INPUT}
            >
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-2 text-small text-fg-muted">
          Quantity · {market}
          <input
            name="quantity"
            required
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className={`${TRADING_INPUT} font-mono tabular-nums`}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-2 text-small text-fg-muted">
            Leverage
            <select name="leverage" defaultValue="2" className={TRADING_INPUT}>
              {[1, 2, 3, 5, 10, 20, 50].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-small text-fg-muted">
            Max margin · USDC
            <input
              name="margin"
              inputMode="decimal"
              placeholder="0.00"
              required
              className={`${TRADING_INPUT} font-mono tabular-nums`}
            />
          </label>
        </div>
        <fieldset className="space-y-3 border-t border-line-card pt-4">
          <legend className="text-small text-fg-muted">Protection</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-2 text-small text-fg-muted">
              Stop-loss · USD
              <input
                name="stop"
                inputMode="decimal"
                required={action === "open"}
                placeholder="Price"
                className={`${TRADING_INPUT} font-mono tabular-nums`}
              />
            </label>
            <label className="flex flex-col gap-2 text-small text-fg-muted">
              Take-profit · USD
              <input
                name="target"
                inputMode="decimal"
                placeholder="Optional"
                className={`${TRADING_INPUT} font-mono tabular-nums`}
              />
            </label>
          </div>
          <label className="flex flex-col gap-2 text-small text-fg-muted">
            Trailing stop
            <select name="trailing" defaultValue="" className={TRADING_INPUT}>
              <option value="">Off</option>
              <option value="100">1%</option>
              <option value="200">2%</option>
              <option value="500">5%</option>
            </select>
          </label>
        </fieldset>
        <label className="flex items-center justify-between gap-3 text-small text-fg-muted">
          Slippage
          <select
            name="slippage"
            defaultValue="50"
            className="min-h-11 rounded-sm border border-line-strong bg-sunken px-3 text-fg-strong"
          >
            <option value="25">0.25%</option>
            <option value="50">0.5%</option>
            <option value="100">1%</option>
          </select>
        </label>
        <p className="text-caption text-fg-muted">
          Isolated margin. Venue fees capped at 0.1%. Reductions cannot flip or increase the position.
        </p>
        {error ? (
          <p role="alert" className="text-small text-warn">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !market} aria-busy={busy}>
          {busy ? "Checking order…" : "Review order"}
        </Button>
      </form>
      <AnimatePresence initial={false}>
        {quote ? (
          <TradeCard key={quote.id} id={quote.id} initial={quote} onClose={() => setQuote(null)} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
export function PerpsScreen({ accountId }: { readonly accountId: string }): ReactElement {
  const [market, setMarket] = useState("BTC"),
    [search, setSearch] = useState("");
  const query = useQuery({
      queryKey: ["perps-markets"],
      queryFn: async () => {
        const r = await getPerpsMarkets();
        if (!r.ok) {
          throw new Error(r.message);
        }
        return r.value;
      },
      staleTime: 5000,
      refetchInterval: 10000,
      retry: false,
    }),
    account = useManualAccount(accountId);
  const rows = query.data ?? [],
    selected = rows.find((r) => r.name === market);
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-page-title">Perps</h1>
          <p className="mt-1 text-small text-fg-muted">
            Trade perpetuals with isolated margin and protective exits.
          </p>
        </div>
        <Link
          href={`/chat?tool=perps&prompt=${encodeURIComponent(`Analyze ${market} perpetuals using current chart indicators and recent news. Give a clear directional view with reasons, entry, take-profit and stop-loss conditions.`)}`}
          className="text-small text-accent-text"
        >
          Analyze with Jarvis
        </Link>
      </div>
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <section className="rounded-lg border border-line-card bg-surface-card p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-lead font-medium">{market} / USD</h2>
              <div className="flex gap-6">
                <p className="text-caption text-fg-muted">
                  Mark
                  <span className="mt-1 block font-mono text-body tabular-nums text-fg-strong">
                    {selected ? `$${decimalDisplay(selected.mark)}` : "—"}
                  </span>
                </p>
                <p className="text-caption text-fg-muted">
                  Hourly funding
                  <span className="mt-1 block font-mono text-body tabular-nums text-fg-strong">
                    {selected ? decimalDisplay(selected.funding, true) : "—"}
                  </span>
                </p>
              </div>
            </div>
            <MarketChart market={market} />
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lead font-medium">Markets</h2>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search perpetual markets"
                placeholder="Search markets"
                className="min-h-11 rounded-sm border border-line-strong bg-sunken px-3 text-small"
              />
            </div>
            <div className="divide-y divide-line-card border-y border-line-card">
              {query.isPending ? (
                <p role="status" className="py-6 text-small text-fg-muted">
                  Loading markets…
                </p>
              ) : query.error ? (
                <p role="alert" className="py-6 text-small text-warn">
                  {query.error.message}
                </p>
              ) : (
                rows
                  .filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
                  .slice(0, 12)
                  .map((r) => (
                    <button
                      type="button"
                      key={r.name}
                      onClick={() => setMarket(r.name)}
                      className={`flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-3 py-3 text-left hover:bg-surface-2 ${market === r.name ? "bg-surface-2" : ""}`}
                    >
                      <span className="text-small font-medium">
                        {r.name}{" "}
                        <span className="ml-2 text-caption text-fg-muted">up to {r.maxLeverage}×</span>
                      </span>
                      <span className="font-mono text-small tabular-nums text-fg-strong">
                        ${decimalDisplay(r.mark)}
                      </span>
                    </button>
                  ))
              )}
            </div>
          </section>
          <section className="border-t border-line-card pt-5">
            <h2 className="text-lead font-medium">Your position</h2>
            {account.data?.positions.length ? (
              account.data.positions.map((p) => (
                <div key={p.market} className="mt-3 flex items-center justify-between gap-3 text-small">
                  <span>
                    {p.market} · {p.side}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatUnits(BigInt(p.quantity), { decimals: p.decimals, fractionDigits: p.decimals })}{" "}
                    {p.market}
                  </span>
                </div>
              ))
            ) : (
              <p className="mt-3 text-small text-fg-muted">
                {account.isPending
                  ? "Checking your trading account…"
                  : account.error
                    ? "Position data unavailable."
                    : "No open manual position."}
              </p>
            )}
          </section>
        </div>
        <PerpsTicket key={market} market={market} />
      </div>
      <TradingAccount accountId={accountId} kind="perps" />
      <TradingHistory accountId={accountId} kind="perps" />
    </div>
  );
}
