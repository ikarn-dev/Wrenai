import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactElement } from "react";

// Shared by the Spot and Memecoins tables, so both read the same way.
export const CELL = "px-3 py-2.5 first:pl-0 last:pr-0";
export const HEAD = `${CELL} py-2 text-left text-caption font-medium text-fg-subtle whitespace-nowrap`;
export const NUM = `${CELL} whitespace-nowrap text-right font-mono tabular-nums`;
export const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";
export const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const TRADE_BUTTON =
  "inline-flex h-8 cursor-pointer items-center rounded-full bg-surface-3 px-3.5 text-caption font-medium text-fg-strong ring-1 ring-line-strong/40 ring-inset transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-4 active:scale-95 motion-reduce:active:scale-100 pointer-coarse:h-11";

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function isNumeric(value: string): value is `${number}` {
  return /^-?\d+(?:\.\d+)?$/.test(value);
}

/** Whole-dollar figures as $145.08M; zero or missing reads as a dash. Intl formats the string exactly. */
export function compactUsd(value: string | null): string {
  return value && value !== "0" && isNumeric(value) ? COMPACT_USD.format(value) : "—";
}

export function compactCount(value: number): string {
  return COMPACT.format(value);
}

/** A percent change with its sign and arrow, so it never relies on color alone (Docs/DESIGN.md → Color). */
export function Change({ value }: { readonly value: string | null }): ReactElement {
  if (value === null) {
    return <span className="text-fg-subtle">—</span>;
  }
  const negative = value.startsWith("-"),
    zero = /^-?0(?:\.0+)?$/.test(value);
  if (zero) {
    return <span className="text-fg-muted">0.00%</span>;
  }
  const Icon = negative ? ArrowDownRight : ArrowUpRight;
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 ${negative ? "text-loss" : "text-gain"}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
      {negative ? `−${value.slice(1)}` : `+${value}`}%
    </span>
  );
}
