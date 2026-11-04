"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { Button } from "@/components/ui/button";
import { getSpotMarkets, prepareManualAccount, requestManualQuote } from "@/server/manual-trading/actions";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { DEFAULT_SPOT_FEE_BPS, type ManualPreview } from "@/shared/manual-trading";
import { NativeFunding } from "./native-funding";
import { TradeCard } from "./trade-card";
import { useManualAccount } from "./trading-history";

const field = "min-h-11 min-w-0 rounded-sm border border-line-strong bg-sunken px-3 py-2 text-small";
export function TradingAccount({
  accountId,
  kind,
}: {
  readonly accountId: string;
  readonly kind: "spot" | "perps";
}): ReactElement {
  const query = useManualAccount(accountId),
    cache = useQueryClient(),
    [busy, startTransition] = useTransition(),
    [error, setError] = useState<string | null>(null),
    [quote, setQuote] = useState<ManualPreview | null>(null),
    [direction, setDirection] = useState("deposit");
  const tokens = useQuery({
    queryKey: ["spot-markets"],
    queryFn: async () => {
      const r = await getSpotMarkets();
      if (!r.ok) {
        throw new Error(r.message);
      }
      return r.value;
    },
    staleTime: 15000,
    retry: false,
  });
  function setup(): void {
    startTransition(async () => {
      setError(null);
      const r = await prepareManualAccount();
      if (!r.ok) {
        setError(r.message);
      } else {
        await cache.invalidateQueries({ queryKey: ["manual-account", accountId] });
      }
    });
  }
  function fund(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      const r = await requestManualQuote({
        requestId: crypto.randomUUID(),
        source: "perps",
        intent: {
          kind: "perps_funding",
          direction,
          assetId: String(data.get("token")),
          amount: String(data.get("amount")),
          slippageBps: 50,
          maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
        },
      });
      if (!r.ok) {
        setError(r.message);
      } else {
        setQuote(r.value);
      }
    });
  }
  const account = query.data;
  const venueCash = account?.balances.find(
    (b) =>
      b.scope === "hyperliquid" &&
      account.perpsAddress &&
      b.assetId.endsWith(account.perpsAddress.toLowerCase()),
  );
  return (
    <section className="min-w-0 border-t border-line-card pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">Trading balances</h2>
        <Link href="/settings/trading-access" className="text-small text-accent-text">
          Trading access
        </Link>
      </div>
      {query.error ? (
        <p role="alert" className="mt-3 text-small text-warn">
          {query.error.message}
        </p>
      ) : null}
      {account?.balanceNotice ? (
        <p className="mt-3 text-small text-fg-muted">{account.balanceNotice}</p>
      ) : null}
      {account && !account.recoveryReady ? (
        <details className="mt-4 rounded-md border border-line-card p-4">
          <summary className="cursor-pointer text-small text-accent-text">
            Set up a recoverable trading account
          </summary>
          <div className="mt-4">
            <TradingRecovery accountId={accountId} agents={[]} initial={null} />
          </div>
        </details>
      ) : null}
      {kind === "spot" ? (
        <div className="mt-4">
          <NativeFunding accountId={accountId} ready={account?.recoveryReady ?? false} />
        </div>
      ) : account?.recoveryReady && !account.perpsAddress ? (
        <div className="mt-4">
          <Button type="button" disabled={busy} onClick={setup}>
            {busy ? "Preparing…" : "Set up manual Perps"}
          </Button>
        </div>
      ) : account?.perpsAddress ? (
        <div className="mt-4 grid items-start gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-small text-fg-muted">Manual Perps · available</p>
            <p className="font-mono text-lead tabular-nums text-fg-strong">
              {venueCash ? budgetTokenAmount(venueCash.availableUnits, 6) : "—"} USDC
            </p>
            <p className="break-all font-mono text-caption text-fg-muted">{account.perpsAddress}</p>
            <p className="text-caption text-fg-muted">
              Separate from agent accounts. Close positions and orders before adding or returning funds.
            </p>
          </div>
          <form onSubmit={fund} onChange={() => setQuote(null)} aria-busy={busy} className="space-y-3">
            <label className="flex flex-col gap-2 text-small text-fg-muted">
              Move funds
              <select value={direction} onChange={(e) => setDirection(e.target.value)} className={field}>
                <option value="deposit">Private balance → Perps</option>
                <option value="return">Perps → private balance</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-small text-fg-muted">
              {direction === "deposit" ? "Pay token" : "Receive token"}
              <select name="token" required className={field} defaultValue="">
                <option value="" disabled>
                  Choose a token
                </option>
                {tokens.data?.map((t) => (
                  <option key={t.assetId} value={t.assetId}>
                    {t.tokenSymbol} · {t.blockchain}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-small text-fg-muted">
              {direction === "deposit" ? "Token amount" : "USDC to return, including the 1 USDC fee"}
              <input
                name="amount"
                required
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className={`${field} font-mono tabular-nums`}
              />
            </label>
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? "Getting quote…" : "Review transfer"}
            </Button>
          </form>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-small text-warn">
          {error}
        </p>
      ) : null}
      <AnimatePresence initial={false}>
        {quote ? (
          <div className="mt-4">
            <TradeCard key={quote.id} id={quote.id} initial={quote} onClose={() => setQuote(null)} />
          </div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
