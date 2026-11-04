"use client";
import { ArrowDown, Timer } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { type ReactElement, useEffect, useState } from "react";
import { formatUnits } from "@/shared/money";
import type { TradeAsset } from "@/shared/trade-preview";

const ICON = { "aria-hidden": true, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** Token amount for display, rounded toward zero (never shows more than the real amount). */
export function tokenAmount(units: string, asset: TradeAsset): string {
  return formatUnits(BigInt(units), { decimals: asset.decimals, fractionDigits: Math.min(asset.decimals, 6) })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** Output per one input token, from exact units: out × 10^inDecimals ÷ in, rounded down. */
function rate(
  inputUnits: string,
  outputUnits: string | null,
  input: TradeAsset,
  output: TradeAsset,
): string | null {
  if (outputUnits === null) {
    return null;
  }
  const scaled = (BigInt(outputUnits) * 10n ** BigInt(input.decimals)) / BigInt(inputUnits);
  return `1 ${input.tokenSymbol} = ${tokenAmount(scaled.toString(), output)} ${output.tokenSymbol}`;
}

/** Seconds left on a quote, ticking once a second while it's open. */
function useSecondsLeft(expiresAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** A compact countdown for the card header; amber in the last five seconds. */
export function QuoteTimer({ expiresAt }: { readonly expiresAt: number }): ReactElement {
  const seconds = useSecondsLeft(expiresAt, true);
  return (
    <span
      role="timer"
      aria-label={seconds > 0 ? `Quote expires in ${seconds} seconds` : "Quote expired"}
      className={`inline-flex items-center gap-1 font-mono text-caption tabular-nums ${seconds <= 5 ? "text-warn" : "text-fg-subtle"}`}
    >
      <Timer {...ICON} size={12} />
      {seconds <= 0
        ? "Expired"
        : seconds >= 60
          ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
          : `${seconds}s`}
    </span>
  );
}

interface PanelProps {
  readonly label: string;
  readonly amount: string;
  readonly symbol: string;
}

function SwapPanel({ label, amount, symbol }: PanelProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-sunken px-3 py-2.5 ring-1 ring-line-card ring-inset">
      <div className="flex min-w-0 flex-col">
        <span className="text-caption text-fg-subtle">{label}</span>
        <span className="truncate font-mono text-lead tabular-nums text-fg-strong" title={amount}>
          {amount}
        </span>
      </div>
      <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-surface-3 px-2.5 text-caption font-medium text-fg-strong ring-1 ring-line-strong/40 ring-inset">
        {symbol}
      </span>
    </div>
  );
}

interface SwapSummaryProps {
  readonly input: TradeAsset;
  readonly output: TradeAsset;
  readonly inputUnits: string;
  /** Expected output from the quote. */
  readonly outputUnits: string | null;
  readonly minimumOutputUnits: string | null;
  /** Set once the swap has settled: what was actually spent and received. */
  readonly settled?: { readonly spentUnits: string; readonly receivedUnits: string } | undefined;
}

/** Pay over receive, joined by a small arrow, then the rate and the guaranteed minimum. */
export function SwapSummary({
  input,
  output,
  inputUnits,
  outputUnits,
  minimumOutputUnits,
  settled,
}: SwapSummaryProps): ReactElement {
  const reduced = useReducedMotion();
  const done = settled;
  const received = done?.receivedUnits ?? outputUnits;
  const minimum = done ? null : minimumOutputUnits;
  const price = rate(inputUnits, outputUnits, input, output);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative flex flex-col gap-1">
        <SwapPanel
          label={done ? "Paid" : "You pay"}
          amount={tokenAmount(done?.spentUnits ?? inputUnits, input)}
          symbol={input.tokenSymbol}
        />
        <m.span
          aria-hidden="true"
          initial={reduced ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 26, delay: reduced ? 0 : 0.12 }}
          className="absolute top-1/2 left-1/2 z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface-3 text-fg-muted ring-4 ring-surface-card"
        >
          <ArrowDown {...ICON} size={14} />
        </m.span>
        <SwapPanel
          label={done ? "Received" : "You receive ≈"}
          amount={received && received !== "0" ? tokenAmount(received, output) : "—"}
          symbol={output.tokenSymbol}
        />
      </div>
      <dl className="flex flex-col gap-1 px-0.5 text-caption">
        {price ? (
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Rate</dt>
            <dd className="font-mono tabular-nums text-fg-muted">{price}</dd>
          </div>
        ) : null}
        {minimum ? (
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">At least</dt>
            <dd className="font-mono tabular-nums text-fg-muted">
              {tokenAmount(minimum, output)} {output.tokenSymbol}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
