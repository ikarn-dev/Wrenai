import type { ReactElement } from "react";
import { BLOCK, SKELETON_ROWS } from "./market-cells";

/** A route fallback with the same title, toolbar and leading rows as the interactive markets. */
export function MarketRouteLoading({ title }: { readonly title: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">{title}</h1>
      <div
        role="status"
        aria-label={`Loading ${title.toLowerCase()} markets`}
        className="flex min-w-0 flex-col gap-3"
      >
        <div aria-hidden="true" className="flex flex-wrap items-center justify-between gap-3">
          <span className={`${BLOCK} h-8 w-40 rounded-full pointer-coarse:h-11`} />
          <span className={`${BLOCK} h-9 w-full max-w-64 rounded-full pointer-coarse:h-11`} />
        </div>
        <div aria-hidden="true" className="overflow-hidden">
          <div className="min-w-3xl">
            <div className="flex h-9 items-center border-b border-line-card">
              <span className={`${BLOCK} h-3 w-16`} />
            </div>
            {SKELETON_ROWS.map((row) => (
              <div
                key={row}
                className="flex h-13 items-center justify-between gap-3 border-b border-line-subtle"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`${BLOCK} size-6 rounded-full`} />
                  <span className={`${BLOCK} h-3.5 w-24`} />
                </div>
                <span className={`${BLOCK} h-3.5 w-16`} />
                <span className={`${BLOCK} h-3.5 w-16`} />
                <span className={`${BLOCK} h-8 w-16 rounded-full`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
