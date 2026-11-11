"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { type FormEvent, type ReactElement, useId, useState, useTransition } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { prepareManualAccount } from "@/server/manual-trading/actions";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { DEFAULT_SPOT_FEE_BPS, type ManualPreview } from "@/shared/manual-trading";
import { type ManualAccountView, spotMarketViewSchema } from "@/shared/market-pages";
import { formatUnits } from "@/shared/money";
import { middleTruncate } from "@/shared/truncate";
import { TRADING_INPUT } from "./fields";
import { CELL, HEAD, NUM } from "./market-cells";
import { displaySymbol, networkName } from "./spot-markets-table";
import { Segment, UnitField } from "./ticket-fields";
import { TradeCard } from "./trade-card";
import { readTrading } from "./trading-api";
import { requestManualQuote } from "./trading-mutations";
import { useManualAccount } from "./use-manual-account";

type Direction = "deposit" | "return";

function Positions({ account }: { readonly account: ManualAccountView }): ReactElement {
  if (account.positions.length === 0) {
    return <p className="text-small text-fg-muted">No open position.</p>;
  }
  return (
    <table className="w-full border-collapse text-small" aria-label="Open positions">
      <thead>
        <tr className="border-b border-line-card">
          <th scope="col" className={HEAD}>
            Market
          </th>
          <th scope="col" className={HEAD}>
            Side
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            Size
          </th>
        </tr>
      </thead>
      <tbody>
        {account.positions.map((p) => (
          <tr key={p.market} className="border-b border-line-subtle">
            <th scope="row" className={`${CELL} text-left font-medium text-fg-strong`}>
              {p.market}
            </th>
            <td className={`${CELL} ${p.side === "long" ? "text-gain" : "text-loss"}`}>
              {p.side === "long" ? "Long" : "Short"}
            </td>
            <td className={`${NUM} text-fg-strong`}>
              {formatUnits(BigInt(p.quantity), { decimals: p.decimals, fractionDigits: p.decimals })}{" "}
              {p.market}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ account }: { readonly account: ManualAccountView }): ReactElement {
  const address = account.perpsAddress ?? "";
  const cash = account.balances.find(
    (b) => b.scope === "hyperliquid" && b.assetId.endsWith(address.toLowerCase()),
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <dl className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-fg-subtle">Available margin</dt>
          <dd className="font-mono text-lead tabular-nums text-fg-strong">
            {cash ? budgetTokenAmount(cash.availableUnits, 6) : "—"}{" "}
            <span className="text-small text-fg-muted">USDC</span>
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-caption text-fg-subtle">Account</dt>
          <dd className="inline-flex items-center gap-0.5">
            <span className="font-mono text-small text-fg-muted" title={address}>
              {middleTruncate(address, 8, 6)}
            </span>
            <CopyButton text={address} label="Copy Perps account" />
          </dd>
        </div>
      </dl>
      <Positions account={account} />
    </div>
  );
}

function MoveFunds({ onQuote }: { readonly onQuote: (quote: ManualPreview) => void }): ReactElement {
  const tokenId = useId();
  const [direction, setDirection] = useState<Direction>("deposit"),
    [token, setToken] = useState(""),
    [amount, setAmount] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  const tokens = useQuery({
    queryKey: ["spot-markets"],
    queryFn: ({ signal }) => readTrading("/api/trading/spot-markets", spotMarketViewSchema, signal),
    staleTime: 15000,
    retry: false,
  });
  const payToken = tokens.data?.tokens.find((t) => t.assetId === token);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const r = await requestManualQuote({
        requestId: crypto.randomUUID(),
        source: "perps",
        intent: {
          kind: "perps_funding",
          direction,
          assetId: token,
          amount: amount.trim(),
          slippageBps: 50,
          maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
        },
      });
      if (r.ok) {
        onQuote(r.value);
      } else {
        setError(r.message);
      }
    });
  }

  return (
    <form onSubmit={submit} aria-busy={busy} className="flex min-w-0 flex-col gap-4">
      <Segment<Direction>
        label="Move funds"
        value={direction}
        onChange={setDirection}
        options={[
          { value: "deposit", label: "Add margin" },
          { value: "return", label: "Withdraw" },
        ]}
      />
      <label htmlFor={tokenId} className="flex flex-col gap-1.5 text-caption text-fg-subtle">
        {direction === "deposit" ? "Pay with" : "Receive as"}
        <select
          id={tokenId}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          className={TRADING_INPUT}
        >
          <option value="" disabled>
            Choose a token
          </option>
          {tokens.data?.tokens.map((t) => (
            <option key={t.assetId} value={t.assetId}>
              {displaySymbol(t)} · {networkName(t.blockchain)}
            </option>
          ))}
        </select>
      </label>
      <UnitField
        label={direction === "deposit" ? "Amount" : "Amount, including the 1 USDC fee"}
        unit={direction === "deposit" ? (payToken ? displaySymbol(payToken) : "") : "USDC"}
        value={amount}
        onChange={setAmount}
        required
      />
      {error ? (
        <p role="alert" className="text-caption text-warn">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" aria-busy={busy} disabled={!token || !amount.trim()}>
          {busy ? <ActivityIndicator size={18} label="Getting quote" /> : "Review transfer"}
        </Button>
      </div>
    </form>
  );
}

/** The manual Perps account: margin, positions and moving funds to and from the private balance. */
export function PerpsAccount({ accountId }: { readonly accountId: string }): ReactElement {
  const query = useManualAccount(accountId),
    cache = useQueryClient(),
    [quote, setQuote] = useState<ManualPreview | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  const account = query.data;

  function setup(): void {
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const r = await prepareManualAccount();
      if (r.ok) {
        await cache.invalidateQueries({ queryKey: ["manual-account", accountId] });
      } else {
        setError(r.message);
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 pt-3">
      {query.error ? (
        <p role="alert" className="text-small text-warn">
          {query.error.message}
        </p>
      ) : null}
      {account?.balanceNotice ? <p className="text-small text-warn">{account.balanceNotice}</p> : null}
      {!account ? null : !account.recoveryReady ? (
        <TradingRecovery accountId={accountId} agents={[]} initial={null} />
      ) : !account.perpsAddress ? (
        <div>
          <Button type="button" variant="secondary" aria-busy={busy} onClick={setup}>
            {busy ? <ActivityIndicator size={18} label="Setting up" /> : "Set up Perps account"}
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-2">
          <Summary account={account} />
          <MoveFunds onQuote={setQuote} />
        </div>
      )}
      {error ? (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      ) : null}
      <AnimatePresence initial={false}>
        {quote ? (
          <TradeCard key={quote.id} id={quote.id} initial={quote} onClose={() => setQuote(null)} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
