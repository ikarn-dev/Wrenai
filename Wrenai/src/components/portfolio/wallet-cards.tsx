"use client";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { readTrading } from "@/components/trading/trading-api";
import { formatCompactMicroUsd, formatUnits } from "@/shared/money";
import {
  PORTFOLIO_WALLET_KEY,
  walletBalanceViewSchema,
  walletValueViewSchema,
} from "@/shared/portfolio-wallet";

const NEAR_DECIMALS = 24;
const MIN_DISPLAY_AMOUNT = 10n ** 20n;
const COMPACT_UNITS = [
  { exponent: 12, suffix: "T" },
  { exponent: 9, suffix: "B" },
  { exponent: 6, suffix: "M" },
  { exponent: 3, suffix: "K" },
] as const;

function displayNear(amount: bigint, compact: boolean): string {
  if (compact && amount === 0n) {
    return "0";
  }
  if (amount > 0n && amount < MIN_DISPLAY_AMOUNT) {
    return "<0.0001";
  }
  if (compact) {
    for (const { exponent, suffix } of COMPACT_UNITS) {
      if (amount >= 10n ** BigInt(NEAR_DECIMALS + exponent)) {
        const value = formatUnits(amount, { decimals: NEAR_DECIMALS + exponent, fractionDigits: 1 });
        return `${value.replace(/\.0$/, "")}${suffix}`;
      }
    }
  }
  return formatUnits(amount, { decimals: NEAR_DECIMALS, fractionDigits: 4 });
}

interface NearAmountProps {
  readonly amount: bigint;
  /** Compact (1.2K) for tight spots such as stat tiles; exact to 4 decimals otherwise. */
  readonly compact?: boolean;
  /** The key figure of a card (the wallet total): num-xl with a small unit. */
  readonly large?: boolean;
}

/** A NEAR amount in mono with its unit; the full 24-decimal value is in the tooltip and for screen readers. */
export function NearAmount({ amount, compact = false, large = false }: NearAmountProps): ReactElement {
  const exact = formatUnits(amount, { decimals: NEAR_DECIMALS, fractionDigits: NEAR_DECIMALS });
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        title={`${exact} NEAR`}
        className={`font-mono tabular-nums text-fg-strong ${large ? "text-num-xl" : ""}`}
      >
        {displayNear(amount, compact)}
      </span>
      <span aria-hidden="true" className={`text-fg-muted ${large ? "text-small" : "text-caption"}`}>
        NEAR
      </span>
      <span className="sr-only">{exact} NEAR</span>
    </span>
  );
}

const UPDATE_MS = 15_000;
const walletRead = {
  staleTime: UPDATE_MS,
  refetchInterval: UPDATE_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  retry: false,
} as const;

/** Native balance renders independently of token discovery and keeps its last successful value during refresh. */
export function WalletValue(): ReactElement {
  const balance = useQuery({
    ...walletRead,
    queryKey: [...PORTFOLIO_WALLET_KEY, "balance"],
    queryFn: ({ signal }) =>
      readTrading("/api/portfolio/wallet?view=balance", walletBalanceViewSchema, signal),
  });
  const valuation = useQuery({
    ...walletRead,
    queryKey: [...PORTFOLIO_WALLET_KEY, "value"],
    queryFn: ({ signal }) => readTrading("/api/portfolio/wallet?view=value", walletValueViewSchema, signal),
  });
  const value = valuation.data;
  const hasEstimate = value && (value.complete || value.knownMicroUsd !== "0");
  const note =
    balance.isError || valuation.isError
      ? "Refresh unavailable"
      : value && !value.complete
        ? "Partial value"
        : null;
  return (
    <span className="flex flex-col gap-1">
      <span className="flex min-h-lh items-center font-mono text-num-xl text-fg-strong tabular-nums">
        {valuation.isPending ? (
          <span
            role="status"
            aria-label="Loading wallet value"
            className="h-6 w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse"
          />
        ) : hasEstimate ? (
          formatCompactMicroUsd(BigInt(value.knownMicroUsd))
        ) : (
          <>
            <span aria-hidden="true" className="text-fg-subtle">
              —
            </span>
            <span className="sr-only">Wallet value unavailable</span>
          </>
        )}
      </span>
      <span className="flex min-h-lh flex-wrap items-baseline gap-x-2 gap-y-1 text-small">
        {balance.data ? (
          <NearAmount amount={BigInt(balance.data.yocto ?? "0")} />
        ) : balance.isPending ? (
          <span
            role="status"
            aria-label="Loading NEAR balance"
            className="block h-3.5 w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse"
          />
        ) : (
          <span className="text-fg-muted">NEAR balance unavailable</span>
        )}
        {value?.otherTokens ? <span className="text-fg-muted">+ {value.otherTokens} more</span> : null}
        {note ? <span className="text-caption text-fg-subtle">{note}</span> : null}
      </span>
    </span>
  );
}
