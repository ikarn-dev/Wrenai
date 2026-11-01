import type { ReactElement } from "react";

export function ActivitySkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading activity" className="min-w-0 card-shine rounded-lg px-card">
      <div aria-hidden="true" className="flex gap-2 border-b border-line-card py-4">
        <span className="h-8 w-40 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
      </div>
      {["first", "second", "third"].map((id) => (
        <div
          key={id}
          aria-hidden="true"
          className="flex min-h-24 items-start gap-3 border-b border-line-card py-4 last:border-0"
        >
          <span className="size-8 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
          <div className="flex flex-1 flex-col gap-2">
            <span className="h-4 w-32 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
            <span className="h-3 w-48 max-w-full rounded-xs bg-surface-2 motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
