import type { ReactElement, ReactNode } from "react";
import { CELL, STICKY_CELL } from "./row";

const COLUMNS = [
  { id: "type", label: "Type", end: false },
  { id: "details", label: "Details", end: false },
  { id: "by", label: "By", end: false },
  { id: "transaction", label: "Transaction", end: false },
  { id: "amount", label: "Amount", end: true },
  { id: "status", label: "Status", end: false },
  { id: "time", label: "Time (UTC)", end: true },
] as const;

interface ActivityTableProps {
  readonly label: string;
  readonly hidden?: boolean;
  readonly children: ReactNode;
}

/**
 * The activity table, indexer style: mono eyebrow headers over full-width rows. It scrolls sideways inside the
 * card on narrow screens and never vertically, so the page keeps one scroll (no data-lenis-prevent needed).
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
                className={`${CELL} py-2.5 font-mono text-eyebrow font-medium whitespace-nowrap text-fg-subtle uppercase ${column.end ? "text-right" : "text-left"} ${position === 0 ? STICKY_CELL : ""}`}
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
