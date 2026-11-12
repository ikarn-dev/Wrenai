import { ArrowDownRight, ArrowUpRight, ChartNoAxesCombined, Coins, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import { StatTile } from "@/components/portfolio/panel";
import type { AgentPerformance } from "@/shared/agent-performance";
import { formatMicroUsd, shortTokenAmount } from "@/shared/money";

const MINUS = "−";
const ARROW = { size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const UTC = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });
const SOURCE = { reference_prices: "Reference prices", tidepool_quote: "Tidepool quote" } as const;

function amount(unit: AgentPerformance["unit"], units: bigint): string {
  return unit.kind === "usd"
    ? formatMicroUsd(units)
    : `${shortTokenAmount(units.toString(), unit.decimals)} ${unit.symbol}`;
}

function Missing(): ReactElement {
  return <span className="text-fg-subtle">—</span>;
}

function Loading(): ReactElement {
  return <span className="block h-lh w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse" />;
}

/** Signed with an arrow, so a loss never relies on color alone (Docs/DESIGN.md → Meaning never relies on color). */
function Pnl({ performance }: { readonly performance: AgentPerformance }): ReactElement {
  if (performance.pnl === null) {
    return <Missing />;
  }
  const pnl = BigInt(performance.pnl),
    magnitude = pnl < 0n ? -pnl : pnl,
    Arrow = pnl < 0n ? ArrowDownRight : ArrowUpRight;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${pnl > 0n ? "text-gain" : pnl < 0n ? "text-loss" : "text-fg-strong"}`}
    >
      {pnl === 0n ? null : <Arrow {...ARROW} />}
      {pnl > 0n ? "+" : pnl < 0n ? MINUS : ""}
      {amount(performance.unit, magnitude)}
    </span>
  );
}

/** The share of what it put in, rounded toward zero so it never reads larger than it is. */
function share(performance: AgentPerformance): string | null {
  if (performance.pnl === null || performance.invested === null || BigInt(performance.invested) === 0n) {
    return null;
  }
  const pnl = BigInt(performance.pnl),
    bps = ((pnl < 0n ? -pnl : pnl) * 10_000n) / BigInt(performance.invested);
  const sign = pnl > 0n ? "+" : pnl < 0n ? MINUS : "";
  return `${sign}${bps / 100n}.${String(bps % 100n).padStart(2, "0")}% of what it put in`;
}

/**
 * PnL, value now and what it put in, as one row of metric cards under the agent's controls. Unmeasurable figures
 * show a dash with the reason, never zero. `performance` is undefined while the first read loads.
 */
export function PerformanceTiles({
  performance,
  error,
}: {
  readonly performance: AgentPerformance | undefined;
  readonly error: string | null;
}): ReactElement {
  const usd = performance?.unit.kind !== "token",
    placeholder = error === null ? <Loading /> : <Missing />;
  return (
    <div aria-busy={performance === undefined} className="grid min-w-0 gap-stack sm:grid-cols-3">
      <StatTile
        icon={ChartNoAxesCombined}
        label="PnL"
        meta={
          error ??
          (performance ? (performance.note ?? share(performance) ?? "Not measurable yet") : "Loading")
        }
      >
        {performance ? <Pnl performance={performance} /> : placeholder}
      </StatTile>
      <StatTile
        icon={Wallet}
        label="Value now"
        meta={
          performance
            ? `${SOURCE[performance.source]} · ${UTC.format(performance.observedAt)} UTC`
            : (error ?? "Loading")
        }
      >
        {performance === undefined ? (
          placeholder
        ) : performance.value === null ? (
          <Missing />
        ) : (
          <span className="font-mono tabular-nums">
            {amount(performance.unit, BigInt(performance.value))}
          </span>
        )}
      </StatTile>
      <StatTile
        icon={Coins}
        label={usd ? "Principal" : "Spent"}
        meta={usd ? "USD value when its funds came in" : "Paid into its filled orders"}
      >
        {performance === undefined ? (
          placeholder
        ) : performance.invested === null ? (
          <Missing />
        ) : (
          <span className="font-mono tabular-nums">
            {amount(performance.unit, BigInt(performance.invested))}
          </span>
        )}
      </StatTile>
    </div>
  );
}
