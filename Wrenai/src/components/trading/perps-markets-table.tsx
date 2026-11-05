"use client";
import type { ReactElement } from "react";
import { type PerpsMarketRow, perpsIcon } from "@/shared/market-pages";
import { decimalDisplay } from "@/shared/trading-display";
import { BLOCK, CELL, Change, compactUsd, HEAD, NUM, SKELETON_ROWS, TRADE_BUTTON } from "./market-cells";
import { TokenIcon } from "./token-icon";

const HEADERS = ["Mark", "24h", "Vol 24h", "Open interest", "Funding 1h", "Max leverage"] as const;

/** Hourly funding as a percent with a real minus sign (Docs/DESIGN.md → Numbers). */
export function fundingDisplay(funding: string): string {
  return decimalDisplay(funding, true).replace(/^-/, "−");
}

function Row({
  row,
  onTrade,
}: {
  readonly row: PerpsMarketRow;
  readonly onTrade: (row: PerpsMarketRow) => void;
}): ReactElement {
  return (
    <tr className="border-b border-line-subtle transition-colors duration-200 ease-ios hover:bg-surface-1">
      <th scope="row" className={`${CELL} text-left font-medium text-fg-strong`}>
        <span className="flex items-center gap-2.5">
          <TokenIcon symbol={row.name} icon={perpsIcon(row.name)} size={24} />
          {row.name}
        </span>
      </th>
      <td className={`${NUM} text-fg-strong`}>${decimalDisplay(row.mark)}</td>
      <td className={NUM}>
        <Change value={row.change24h} />
      </td>
      <td className={`${NUM} text-fg`}>{compactUsd(row.volume24h)}</td>
      <td className={`${NUM} text-fg`}>{compactUsd(row.openInterest)}</td>
      <td className={`${NUM} text-fg-muted`}>{fundingDisplay(row.funding)}</td>
      <td className={`${NUM} text-fg-muted`}>{row.maxLeverage}×</td>
      <td className={`${CELL} text-right`}>
        <button
          type="button"
          onClick={() => onTrade(row)}
          aria-label={`Trade ${row.name}`}
          className={TRADE_BUTTON}
        >
          Trade
        </button>
      </td>
    </tr>
  );
}

function SkeletonRows(): ReactElement {
  return (
    <>
      {SKELETON_ROWS.map((row) => (
        <tr key={row} className="border-b border-line-subtle">
          <td className={CELL}>
            <span className="flex items-center gap-2.5">
              <span className={`${BLOCK} size-6 rounded-full`} />
              <span className={`${BLOCK} h-3.5 w-14`} />
            </span>
          </td>
          {HEADERS.map((cell) => (
            <td key={cell} className={CELL}>
              <span className={`${BLOCK} ml-auto h-3.5 w-14`} />
            </td>
          ))}
          <td className={CELL}>
            <span className={`${BLOCK} ml-auto h-8 w-16 rounded-full`} />
          </td>
        </tr>
      ))}
    </>
  );
}

interface PerpsMarketsTableProps {
  /** null while the first read loads. */
  readonly rows: readonly PerpsMarketRow[] | null;
  readonly onTrade: (row: PerpsMarketRow) => void;
}

/** Hyperliquid perpetuals, flat: mark, 24 h change and volume, open interest, funding and leverage cap. */
export function PerpsMarketsTable({ rows, onTrade }: PerpsMarketsTableProps): ReactElement {
  return (
    <div className="-mx-gutter overflow-x-auto px-gutter">
      <table
        className="w-full min-w-3xl border-collapse text-small"
        aria-busy={rows === null}
        aria-label="Perpetual markets"
      >
        <thead>
          <tr className="border-b border-line-card">
            <th scope="col" className={HEAD}>
              Market
            </th>
            {HEADERS.map((label) => (
              <th key={label} scope="col" className={`${HEAD} text-right`}>
                {label === "24h" ? <span className="sr-only">Price change </span> : null}
                {label}
              </th>
            ))}
            <th scope="col" className={HEAD}>
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            <SkeletonRows />
          ) : (
            rows.map((row) => <Row key={row.name} row={row} onTrade={onTrade} />)
          )}
        </tbody>
      </table>
    </div>
  );
}
