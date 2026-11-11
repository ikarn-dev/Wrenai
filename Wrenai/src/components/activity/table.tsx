import type { ReactElement, ReactNode } from "react";
import { CELL, STICKY_CELL } from "./row";

const COLUMNS = [
  { id: "type", label: "Type" },
  { id: "details", label: "Details" },
  { id: "transaction", label: "Transaction" },
  { id: "amount", label: "Amount" },
  { id: "status", label: "Status" },
  { id: "time", label: "Time (UTC)" },
] as const;

interface ActivityTableProps {
  readonly label: string;
  readonly hidden?: boolean;
  readonly children: ReactNode;
}

/** First column left, last column right, everything between centered (user choice, Nov 5 2026). */
export function columnAlign(position: number, count: number): string {
  return position === 0 ? "text-left" : position === count - 1 ? "text-right" : "text-center";
}

/**
 * The activity table, indexer style: mono eyebrow headers over full-width rows, aligned by `columnAlign`. It scrolls sideways inside the card on narrow screens and never vertically, so the page
 * keeps one scroll (no data-lenis-prevent needed).
 */
export function ActivityTable({ label, hidden = false, children }: ActivityTableProps): ReactElement {
  return (
    <div className="overflow-x-auto overscroll-x-contain" aria-hidden={hidden ? true : undefined}>
      <table aria-label={label} className="w-full min-w-4xl border-collapse">
        <thead>
          <tr>
            {COLUMNS.map((column, position) => (
              <th
                key={column.id}
                scope="col"
                className={`${CELL} py-2.5 font-mono text-eyebrow font-medium whitespace-nowrap text-fg-subtle uppercase ${columnAlign(position, COLUMNS.length)} ${position === 0 ? STICKY_CELL : ""}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
