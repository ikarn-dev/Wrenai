import { Wallet } from "lucide-react";
import type { ReactElement } from "react";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import { formatUnits } from "@/shared/money";
import { PortfolioPanel } from "./panel";

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

function AssetsUnavailable(): ReactElement {
  return (
    <div role="status" className="flex flex-1 items-center gap-3 py-6">
      <Wallet
        aria-hidden="true"
        size={20}
        strokeWidth={1.75}
        absoluteStrokeWidth
        className="text-fg-subtle"
      />
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium text-fg-strong">Couldn't load your assets</p>
        <p className="text-small text-fg-muted">Use Refresh to try again.</p>
      </div>
    </div>
  );
}

const HEAD = "pb-3 text-left font-mono text-eyebrow font-medium uppercase text-fg-subtle";

export function AssetsCard({ reading }: { readonly reading: WalletBalanceReading }): ReactElement {
  return (
    <PortfolioPanel
      id="assets"
      title="Holdings"
      aside={<span className="text-caption text-fg-subtle">NEAR wallet</span>}
    >
      {reading.kind === "unavailable" ? (
        <AssetsUnavailable />
      ) : (
        <div data-lenis-prevent className="overflow-x-auto">
          <table className="w-full min-w-sm border-collapse text-body">
            <caption className="sr-only">Native NEAR balance. USD prices are not available.</caption>
            <thead>
              <tr className="border-b border-line-card">
                <th scope="col" className={HEAD}>
                  Asset
                </th>
                <th scope="col" className={`${HEAD} pl-4 text-right`}>
                  Balance
                </th>
                <th scope="col" className={`${HEAD} pl-4 text-right`}>
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="py-4 text-left font-normal">
                  <span className="block text-fg-strong">NEAR</span>
                  <span className="mt-0.5 block text-caption text-fg-subtle">Native token</span>
                </th>
                <td className="py-4 pl-4 text-right">
                  <NearAmount amount={reading.kind === "balance" ? reading.yocto : 0n} />
                </td>
                <td
                  aria-label="USD value unavailable"
                  className="py-4 pl-4 text-right font-mono text-fg-subtle"
                >
                  —
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-caption text-fg-subtle">
        <p>
          {reading.kind === "no_account"
            ? "This account isn't on chain yet."
            : "Native NEAR only. USD prices unavailable."}
        </p>
        <ReadTime reading={reading} />
      </div>
    </PortfolioPanel>
  );
}
