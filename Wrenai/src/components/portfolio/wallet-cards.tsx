import type { ReactElement } from "react";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import { formatUnits } from "@/shared/money";

const NEAR_DECIMALS = 24;
const MIN_DISPLAY_AMOUNT = 10n ** 20n;
const READ_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
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

/** Where and when the wallet balance was read, or a warning when it couldn't be. */
export function ReadTime({ reading }: { readonly reading: WalletBalanceReading }): ReactElement {
  if (reading.kind === "unavailable") {
    return <span className="text-warn">Couldn't read balance. Refresh to retry.</span>;
  }
  return (
    <span>
      NEAR RPC ·{" "}
      <time dateTime={new Date(reading.readAt).toISOString()}>{READ_TIME.format(reading.readAt)} UTC</time>
    </span>
  );
}
