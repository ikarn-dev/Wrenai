import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Badge, type BadgeTone, badgeClasses } from "@/components/ui/badge";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { ClaimAmount } from "@/shared/claims";
import { formatMicroUsd, shortTokenAmount } from "@/shared/money";
import { middleTruncate } from "@/shared/truncate";

const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const MINUS = "−";

/** Token amounts, one per line, exact in the tooltip. Unknown precision shows exact base units. */
export function Amounts({ amounts }: { readonly amounts: readonly ClaimAmount[] }): ReactElement {
  if (amounts.length === 0) {
    return <span className="text-fg-subtle">—</span>;
  }
  return (
    <span className="flex flex-col items-center gap-0.5">
      {amounts.map((amount) => {
        const exact =
          amount.decimals === null ? amount.units : budgetTokenAmount(amount.units, amount.decimals);
        return (
          <span
            key={amount.assetId}
            title={`${exact} ${amount.symbol}`}
            className="whitespace-nowrap text-fg-strong"
          >
            {amount.decimals === null ? amount.units : shortTokenAmount(amount.units, amount.decimals)}{" "}
            <span className="text-fg-muted">{amount.symbol}</span>
          </span>
        );
      })}
    </span>
  );
}

/** A USD estimate under an amount, or nothing when it can't be priced. */
export function Usd({ microUsd }: { readonly microUsd: string | null }): ReactElement | null {
  return microUsd === null ? null : (
    <span className="text-caption text-fg-subtle">{formatMicroUsd(BigInt(microUsd))}</span>
  );
}

/** Signed USD result and its share of the deposit, in a badge with an arrow (Docs/DESIGN.md → Numbers). */
export function PnlBadge({
  pnlMicroUsd,
  principalMicroUsd,
}: {
  readonly pnlMicroUsd: string | null;
  readonly principalMicroUsd: string | null;
}): ReactElement {
  if (pnlMicroUsd === null) {
    return (
      <span
        title="A token has no current price, or a deposit has no recorded USD value"
        className="text-fg-subtle"
      >
        Unavailable
      </span>
    );
  }
  const pnl = BigInt(pnlMicroUsd),
    magnitude = pnl < 0n ? -pnl : pnl,
    sign = pnl > 0n ? "+" : pnl < 0n ? MINUS : "";
  const principal = principalMicroUsd === null ? 0n : BigInt(principalMicroUsd);
  // Basis points, rounded toward zero so the share never reads larger than it is.
  const bps = principal > 0n ? (magnitude * 10_000n) / principal : null;
  const share = bps === null ? "" : ` · ${sign}${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;
  const tone: BadgeTone = pnl > 0n ? "accent" : pnl < 0n ? "loss" : "neutral";
  const Arrow = pnl < 0n ? ArrowDownRight : ArrowUpRight;
  return (
    <Badge tone={tone}>
      {pnl === 0n ? null : <Arrow {...ICON} />}
      <span className="font-mono tabular-nums">
        {sign}
        {formatMicroUsd(magnitude)}
        {share}
      </span>
    </Badge>
  );
}

/** The row's action as a badge-shaped button (Docs/DESIGN.md → Badges → badge-styled buttons). */
export function BadgeButton({
  tone,
  icon: Icon,
  busy = false,
  onClick,
  children,
}: {
  readonly tone: BadgeTone;
  readonly icon: LucideIcon;
  readonly busy?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      aria-busy={busy}
      onClick={() => (busy ? undefined : onClick())}
      className={`${badgeClasses(tone)} cursor-pointer transition-[box-shadow,scale] duration-200 ease-ios hover:ring-current active:scale-96 motion-reduce:active:scale-100 aria-busy:cursor-default`}
    >
      <Icon {...ICON} className={busy ? "motion-safe:animate-spin" : ""} />
      {children}
    </button>
  );
}

export function TransactionLink({ hash }: { readonly hash: string }): ReactElement {
  return (
    <a
      href={`https://nearblocks.io/txns/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      aria-label="View transaction on NearBlocks"
      className="rounded-xs font-mono text-small text-accent-text underline-offset-4 hover:underline"
    >
      {middleTruncate(hash, 6, 4)}
    </a>
  );
}
