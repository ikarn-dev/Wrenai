import type { ReactElement } from "react";
import { CELL, STICKY_CELL } from "./row";
import { ActivityTable } from "./table";

const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";
const ROWS = ["first", "second", "third", "fourth", "fifth", "sixth"] as const;

/** Placeholder rows with the real columns' shapes, for the table while a filter or refresh loads. */
export function ActivitySkeletonRows(): ReactElement {
  return (
    <>
      {ROWS.map((row) => (
        <tr key={row} className="border-t border-line-card">
          <td className={`${CELL} ${STICKY_CELL}`}>
            <span className="flex items-center gap-2.5">
              <span className={`${BLOCK} size-4`} />
              <span className={`${BLOCK} h-3.5 w-28`} />
            </span>
          </td>
          <td className={CELL}>
            <span className="flex items-center gap-2">
              <span className={`${BLOCK} h-3.5 w-24`} />
              <span className={`${BLOCK} h-5 w-20`} />
            </span>
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} h-3.5 w-20`} />
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} h-3.5 w-24`} />
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} ml-auto h-3.5 w-20`} />
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} h-6 w-26`} />
          </td>
          <td className={CELL}>
            <span className="flex flex-col items-end gap-1.5">
              <span className={`${BLOCK} h-3.5 w-10`} />
              <span className={`${BLOCK} h-3 w-20`} />
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}

/** The whole activity card while it loads: toolbar, table and footer in their final positions. */
export function ActivitySkeleton(): ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading activity"
      className="min-w-0 overflow-hidden card-shine rounded-lg"
    >
      <div aria-hidden="true" className="flex items-center justify-between gap-3 px-card py-3">
        <span className={`${BLOCK} h-8 w-36 rounded-sm`} />
        <span className={`${BLOCK} size-8 rounded-full`} />
      </div>
      <ActivityTable label="Loading activity" hidden>
        <ActivitySkeletonRows />
      </ActivityTable>
      <div
        aria-hidden="true"
        className="flex items-center justify-between border-t border-line-card px-card py-3.5"
      >
        <span className={`${BLOCK} h-3 w-44`} />
        <span className={`${BLOCK} h-3 w-24`} />
      </div>
    </div>
  );
}
