"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, X } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import Link from "next/link";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { type ManualPreview, manualPreviewSchema } from "@/shared/manual-trading";
import { formatUnits } from "@/shared/money";
import { QuoteTimer, SwapSummary, tokenAmount } from "./swap-summary";
import { readTrading } from "./trading-api";
import { confirmManualOrder, dismissManualOrder, requestManualQuote } from "./trading-mutations";

export function TradeCard({
  id,
  initial,
  onClose,
}: {
  readonly id: string;
  readonly initial?: ManualPreview;
  readonly onClose?: () => void;
}): ReactElement {
  const cache = useQueryClient(),
    reduced = useReducedMotion();
  const [busy, startTransition] = useTransition(),
    [error, setError] = useState<string | null>(null),
    [currentId, setCurrentId] = useState(id);
  const query = useQuery({
    queryKey: ["manual-order", currentId],
    queryFn: ({ signal }) =>
      readTrading(`/api/trading/orders/${encodeURIComponent(currentId)}`, manualPreviewSchema, signal),
    ...(initial && currentId === initial.id ? { initialData: initial } : {}),
    staleTime: 1000,
    refetchInterval: (q) => {
      const value = q.state.data;
      if (!value || ["settled", "refunded", "no_fill", "cancelled", "expired"].includes(value.status)) {
        return false;
      }
      return value.status === "quoted" ? Math.max(1000, value.expiresAt - Date.now()) : 5000;
    },
    retry: false,
  });
  const trade = query.data;
  const lastPayment = useRef<{ id: string; status: ManualPreview["status"] } | null>(null);
  useEffect(() => {
    if (trade?.intent.kind !== "payment") {
      return;
    }
    const previous = lastPayment.current;
    lastPayment.current = { id: trade.id, status: trade.status };
    if (previous?.id !== trade.id || previous.status === trade.status) {
      return;
    }
    if (trade.status === "settled") {
      notify("success", "Payment sent.");
    } else if (trade.status === "refunded") {
      notify("info", "Payment refunded.");
    }
  }, [trade]);
  function run(kind: "confirm" | "dismiss" | "refresh"): void {
    // Busy buttons stay readable and enabled (Docs/DESIGN.md → Buttons); further clicks are ignored here.
    if (!trade || busy) {
      return;
    }
    const snapshot = trade;
    startTransition(async () => {
      setError(null);
      try {
        if (kind === "dismiss") {
          const r = await dismissManualOrder({
            id: snapshot.id,
            revision: snapshot.revision,
            bindingHash: snapshot.bindingHash,
          });
          if (!r.ok) {
            setError(r.message);
            return;
          }
          cache.setQueryData(["manual-order", currentId], { ...snapshot, status: "cancelled" });
          onClose?.();
          return;
        }
        const r =
          kind === "confirm"
            ? await confirmManualOrder({
                id: snapshot.id,
                revision: snapshot.revision,
                bindingHash: snapshot.bindingHash,
              })
            : await requestManualQuote({
                requestId: crypto.randomUUID(),
                source: snapshot.intent.kind === "wallet_return" ? "portfolio" : "jarvis",
                intent: snapshot.intent,
              });
        if (!r.ok) {
          setError(r.message);
          return;
        }
        cache.setQueryData(["manual-order", r.value.id], r.value);
        setCurrentId(r.value.id);
        await cache.invalidateQueries({ queryKey: ["manual-account"] });
      } catch {
        setError("The result could not be confirmed. Check this order before retrying.");
      }
    });
  }
  if (!trade) {
    return (
      <div role="status" className="card-shine rounded-lg p-card text-small text-fg-muted">
        {query.error?.message ?? "Loading quote…"}
      </div>
    );
  }
  const quoted = trade.status === "quoted",
    terminal = ["settled", "refunded", "no_fill", "cancelled"].includes(trade.status);
  const canAutomate =
    trade.intent.kind === "perps" ||
    (trade.intent.kind === "spot" && trade.intent.balance === "confidential");
  const swap =
    trade.intent.kind === "spot" && trade.input && trade.output
      ? { input: trade.input, output: trade.output }
      : null;
  const walletReturn = trade.intent.kind === "wallet_return";
  const payment = trade.intent.kind === "payment";
  return (
    <m.section
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reduced ? 0 : 4 }}
      transition={{ duration: reduced ? 0 : 0.36, ease: [0.32, 0.72, 0, 1] }}
      aria-label="Trade confirmation"
      className="flex w-full max-w-sm flex-col gap-3 card-shine rounded-lg p-3.5"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-small font-medium text-fg-strong">{swap ? "Swap" : trade.title}</h3>
          <span className="truncate text-caption text-fg-subtle">
            {trade.visibility === "public" ? trade.venue : `${trade.venue} · Private`}
          </span>
        </div>
        {quoted ? (
          <div className="-mr-1 flex shrink-0 items-center gap-1">
            <QuoteTimer expiresAt={trade.expiresAt} />
            <button
              type="button"
              onClick={() => run("dismiss")}
              disabled={busy}
              aria-label="Dismiss quote"
              title="Dismiss quote"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-[background-color,color,scale] duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong active:scale-90 motion-reduce:active:scale-100 pointer-coarse:size-11"
            >
              <X aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          </div>
        ) : null}
      </header>
      {swap ? (
        <SwapSummary
          input={swap.input}
          output={swap.output}
          inputUnits={trade.inputUnits}
          outputUnits={trade.outputUnits}
          minimumOutputUnits={trade.minimumOutputUnits}
          settled={trade.execution}
        />
      ) : (
        <TradeRows trade={trade} />
      )}
      {error || query.error ? (
        <p role="alert" className="text-small text-warn">
          {error ?? query.error?.message}
        </p>
      ) : null}
      <div className="flex flex-col gap-2.5">
        {quoted ? (
          <div className="grid">
            <Button type="button" variant="primary" aria-busy={busy} onClick={() => run("confirm")}>
              {busy ? (
                <ActivityIndicator size={18} label="Confirming" />
              ) : swap ? (
                "Confirm swap"
              ) : walletReturn ? (
                "Confirm return"
              ) : payment ? (
                "Confirm payment"
              ) : (
                "Confirm trade"
              )}
            </Button>
          </div>
        ) : trade.status === "expired" && trade.intent.kind === "spot" && !trade.pairVerified ? (
          <p role="status" className="text-small text-fg-muted">
            Request a new quote with the exact tokens.
          </p>
        ) : trade.status === "expired" && payment ? (
          <p role="status" className="text-small text-fg-muted">
            Payment expired. Ask for a fresh payment.
          </p>
        ) : trade.status === "expired" ? (
          <div className="grid">
            <Button type="button" variant="soft" aria-busy={busy} onClick={() => run("refresh")}>
              {busy ? (
                <ActivityIndicator size={18} label="Refreshing quote" />
              ) : (
                <>
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
                  Refresh quote
                </>
              )}
            </Button>
          </div>
        ) : (
          <p role="status" className="inline-flex items-center gap-2 text-small text-fg-muted">
            {trade.status === "settled" ? (
              <Check
                aria-hidden="true"
                size={16}
                strokeWidth={1.75}
                absoluteStrokeWidth
                className="text-accent-text"
              />
            ) : null}
            {(payment
              ? PAYMENT_STATUS_TEXT[trade.status]
              : walletReturn
                ? RETURN_STATUS_TEXT[trade.status]
                : STATUS_TEXT[trade.status]) ?? "Trade submitted · waiting for confirmation"}
            {trade.transactionHash ? (
              <a
                href={`https://nearblocks.io/txns/${trade.transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
                title={trade.transactionHash}
                className="font-mono text-accent-text underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            ) : null}
          </p>
        )}
        {!quoted && !terminal && trade.status !== "expired" ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => run("confirm")}>
            Resume check
          </Button>
        ) : null}
        {trade.status === "unknown" ? (
          <p className="text-caption text-warn">
            The submission may have succeeded. Funds remain reserved while its receipt is checked.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <details className="group/fees text-caption text-fg-subtle">
            <summary className="cursor-pointer list-none rounded-xs transition-colors duration-200 ease-ios hover:text-fg-strong [&::-webkit-details-marker]:hidden">
              Fees and terms
            </summary>
            <p className="mt-2 max-w-sm leading-relaxed">{trade.feeNote}</p>
          </details>
          {(quoted || terminal) && canAutomate ? (
            <Link
              href={`/agents?create=${trade.intent.kind === "perps" ? "perps" : "spot_trader"}&manual=${trade.id}`}
              className="text-caption text-accent-text hover:underline"
            >
              Automate with an agent
            </Link>
          ) : null}
        </div>
      </div>
    </m.section>
  );
}

const STATUS_TEXT: Readonly<Partial<Record<ManualPreview["status"], string>>> = {
  settled: "Swap settled",
  refunded: "Funds returned · no trade filled",
  no_fill: "Order closed · no fill",
  unknown: "Checking transaction",
  cancelled: "Quote dismissed",
};

const RETURN_STATUS_TEXT: Readonly<Partial<Record<ManualPreview["status"], string>>> = {
  settled: "Returned to your wallet",
  refunded: "Return refunded to your private balance",
  reserved: "Returning funds",
  submitting: "Returning funds",
  submitted: "Returning funds · waiting for delivery",
  unknown: "Checking the transfer",
  cancelled: "Return dismissed",
};

const PAYMENT_STATUS_TEXT: Readonly<Partial<Record<ManualPreview["status"], string>>> = {
  reserved: "Preparing payment",
  submitting: "Sending payment",
  submitted: "Waiting for delivery",
  settled: "Payment sent",
  refunded: "Payment refunded",
  unknown: "Checking payment",
  cancelled: "Payment dismissed",
};

/** Perps and other non-swap trades: their terms as label and value rows. */
function TradeRows({ trade }: { readonly trade: ManualPreview }): ReactElement {
  const unitsOut = trade.execution?.receivedUnits ?? trade.minimumOutputUnits;
  const output =
    trade.output && unitsOut && unitsOut !== "0"
      ? `${tokenAmount(unitsOut, trade.output)} ${trade.output.tokenSymbol}`
      : null;
  const rows = [
    {
      label: trade.execution && trade.input ? "Spent" : "Maximum debit",
      value:
        trade.execution && trade.input
          ? `${tokenAmount(trade.execution.spentUnits, trade.input)} ${trade.input.tokenSymbol}`
          : trade.maximumDebit,
    },
    ...(trade.intent.kind === "payment" ? [{ label: "Recipient", value: trade.intent.recipient }] : []),
    ...(output
      ? [
          {
            label:
              trade.intent.kind === "payment"
                ? "Payment amount"
                : trade.execution
                  ? "Received"
                  : "Receive at least",
            value: output,
          },
        ]
      : []),
    ...(trade.limitPrice ? [{ label: "Limit price", value: trade.limitPrice }] : []),
    ...(trade.intent.kind === "perps" && trade.intent.action === "open"
      ? [
          { label: "Stop-loss", value: trade.intent.stopLossPrice ?? "—" },
          { label: "Take-profit", value: trade.intent.takeProfitPrice ?? "—" },
          {
            label: "Trailing stop",
            value:
              trade.intent.trailingStopBps === null
                ? "Off"
                : `${formatUnits(BigInt(trade.intent.trailingStopBps), { decimals: 2, fractionDigits: 2 })}%`,
          },
        ]
      : []),
    {
      label: "Route",
      value: `${trade.venue} · ${trade.visibility === "public" ? "Public" : "Private balance"}`,
    },
  ];
  return (
    <dl className="flex flex-col gap-1.5 rounded-md bg-sunken px-3 py-2.5 text-caption ring-1 ring-line-card ring-inset">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-fg-subtle">{row.label}</dt>
          <dd className="break-all text-right font-mono tabular-nums text-fg-strong">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
