"use client";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { readTrading } from "@/components/trading/trading-api";
import { formatCompactMicroUsd, formatExactMicroUsd, formatUnits } from "@/shared/money";
import {
  PORTFOLIO_WALLET_BALANCE_KEY,
  PORTFOLIO_WALLET_VALUE_KEY,
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
      {/* Beside a large figure the unit steps down to small; otherwise it matches the amount's own size. */}
      <span aria-hidden="true" className={`text-fg-muted ${large ? "text-small" : ""}`}>
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

function WalletPlaceholder({ label }: { readonly label: string }): ReactElement {
  return (
    <span className="relative block">
      <span aria-hidden="true" className="invisible">
        0
      </span>
      <span
        role="status"
        aria-label={label}
        className="absolute inset-y-0 left-0 w-20 max-w-full rounded-xs bg-surface-2 motion-safe:animate-pulse"
      />
    </span>
  );
}

function WalletValueLayout({
  usd,
  near,
  detail = "",
}: {
  readonly usd: ReactNode;
  readonly near: ReactNode;
  readonly detail?: string;
}): ReactElement {
  return (
    <span className="@container block">
      <span className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 @min-[24rem]:grid-cols-[auto_6rem_minmax(0,1fr)]">
        <span className="block w-[7ch] truncate font-mono text-num-xl text-fg-strong tabular-nums">
          {usd}
        </span>
        <span className="block truncate text-small text-fg-muted">{near}</span>
        <span
          className="col-span-full truncate text-small text-fg-subtle @min-[24rem]:col-span-1"
          title={detail || undefined}
        >
          {detail || (
            <span aria-hidden="true" className="invisible">
              0
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

export function WalletValueSkeleton(): ReactElement {
  return (
    <WalletValueLayout
      usd={<WalletPlaceholder label="Loading wallet value" />}
      near={<WalletPlaceholder label="Loading NEAR balance" />}
    />
  );
}

function UnavailableValue({ label }: { readonly label: string }): ReactElement {
  return (
    <span className="text-fg-subtle">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Native balance renders independently of token discovery and keeps its last successful value during refresh. */
export function WalletValue(): ReactElement {
  const balance = useQuery({
    ...walletRead,
    queryKey: PORTFOLIO_WALLET_BALANCE_KEY,
    queryFn: ({ signal }) =>
      readTrading("/api/portfolio/wallet?view=balance", walletBalanceViewSchema, signal),
  });
  const valuation = useQuery({
    ...walletRead,
    queryKey: PORTFOLIO_WALLET_VALUE_KEY,
    queryFn: ({ signal }) => readTrading("/api/portfolio/wallet?view=value", walletValueViewSchema, signal),
  });
  const value = valuation.data;
  const estimate =
    value && (value.complete || value.knownMicroUsd !== "0") ? BigInt(value.knownMicroUsd) : null;
  const details = [
    value && !value.complete ? "Partial value" : null,
    balance.isError || valuation.isError ? "Refresh unavailable" : null,
    value?.otherTokens ? `+ ${value.otherTokens} more` : null,
  ].filter(Boolean);
  return (
    <WalletValueLayout
      usd={
        valuation.isPending ? (
          <WalletPlaceholder label="Loading wallet value" />
        ) : estimate !== null ? (
          <span title={formatExactMicroUsd(estimate)}>{formatCompactMicroUsd(estimate)}</span>
        ) : (
          <UnavailableValue label="Wallet value unavailable" />
        )
      }
      near={
        balance.data ? (
          <NearAmount amount={BigInt(balance.data.yocto ?? "0")} compact />
        ) : balance.isPending ? (
          <WalletPlaceholder label="Loading NEAR balance" />
        ) : (
          <UnavailableValue label="NEAR balance unavailable" />
        )
      }
      detail={details.join(" · ")}
    />
  );
}
