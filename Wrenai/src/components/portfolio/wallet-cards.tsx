import type { ReactElement } from "react";
import { currentPortfolioValuation } from "@/server/portfolio/current-valuation";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import { formatCompactMicroUsd, formatUnits } from "@/shared/money";

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

const ROW = "flex flex-wrap items-baseline gap-x-5 gap-y-1";

function NearHoldings({
  wallet,
  others,
  large = false,
}: {
  readonly wallet: WalletBalanceReading;
  readonly others: number;
  readonly large?: boolean;
}): ReactElement {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      {wallet.kind === "unavailable" ? (
        <span className="text-fg-muted">NEAR balance unavailable</span>
      ) : (
        <NearAmount amount={wallet.kind === "balance" ? wallet.yocto : 0n} large={large} />
      )}
      {others > 0 ? <span className="text-small text-fg-muted">+ {others} more</span> : null}
    </span>
  );
}

/** While the wallet's tokens and prices load: the NEAR balance, with the USD figure's space held. */
export function WalletValueSkeleton({ wallet }: { readonly wallet: WalletBalanceReading }): ReactElement {
  return (
    <span className={ROW}>
      <span
        role="status"
        aria-label="Loading wallet value"
        className="block h-lh w-28 rounded-xs bg-surface-2 text-num-xl motion-safe:animate-pulse"
      />
      <NearHoldings wallet={wallet} others={0} />
    </span>
  );
}

/**
 * The wallet's value in USD across every token it holds, then its NEAR balance and how many other tokens it
 * holds. When no token could be priced, the NEAR balance is the figure instead of a misleading $0.00.
 */
export async function WalletValue({
  wallet,
}: {
  readonly wallet: WalletBalanceReading;
}): Promise<ReactElement> {
  const location = (await currentPortfolioValuation()).locations.find((item) => item.id === "wallet");
  const others = location?.holdings.filter((holding) => holding.assetId !== "native:near").length ?? 0;
  if (!location || (location.knownMicroUsd === 0n && !location.complete)) {
    return (
      <span className={ROW}>
        <NearHoldings wallet={wallet} others={others} large />
      </span>
    );
  }
  return (
    <span className={ROW}>
      <span className="font-mono text-num-xl tabular-nums text-fg-strong">
        {formatCompactMicroUsd(location.knownMicroUsd)}
      </span>
      <NearHoldings wallet={wallet} others={others} />
    </span>
  );
}
