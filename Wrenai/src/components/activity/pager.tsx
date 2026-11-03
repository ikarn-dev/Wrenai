import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";

const ICON = { "aria-hidden": true, size: 15, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;
const STEP =
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong disabled:cursor-not-allowed disabled:text-fg-disabled disabled:hover:bg-transparent aria-busy:cursor-default pointer-coarse:size-11";

type Slot = { readonly kind: "page"; readonly index: number } | { readonly kind: "gap"; readonly id: string };

/** First, last loaded and the pages around the current one; gaps stand in for the rest. */
function pageSlots(loaded: number, current: number): readonly Slot[] {
  const shown = new Set(
    [0, loaded - 1, current - 1, current, current + 1].filter((i) => i >= 0 && i < loaded),
  );
  const slots: Slot[] = [];
  let previous = -1;
  for (const index of [...shown].sort((a, b) => a - b)) {
    if (index - previous > 1) {
      slots.push({ kind: "gap", id: `gap-${index}` });
    }
    slots.push({ kind: "page", index });
    previous = index;
  }
  return slots;
}

interface ActivityPagerProps {
  readonly current: number;
  readonly loaded: number;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onSelect: (index: number) => void;
  readonly onNext: () => void;
  /** Hover or focus on Next: start loading the next page before the click. */
  readonly onNextIntent: () => void;
}

/**
 * Pages are fetched by cursor, so the total isn't known: the pager lists the pages already loaded, and Next loads
 * one more. Loaded pages are kept, so going back never sends a request.
 */
export function ActivityPager({
  current,
  loaded,
  hasMore,
  loadingMore,
  onSelect,
  onNext,
  onNextIntent,
}: ActivityPagerProps): ReactElement {
  const atEnd = current >= loaded - 1 && !hasMore;
  return (
    <nav aria-label="Activity pages" className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect(current - 1)}
        disabled={current === 0}
        aria-label="Previous page"
        className={STEP}
      >
        <ChevronLeft {...ICON} />
      </button>
      {pageSlots(loaded, current).map((slot) =>
        slot.kind === "gap" ? (
          <span
            key={slot.id}
            aria-hidden="true"
            className="w-6 text-center font-mono text-small text-fg-subtle"
          >
            …
          </span>
        ) : (
          <button
            key={slot.index}
            type="button"
            onClick={() => onSelect(slot.index)}
            aria-label={`Page ${slot.index + 1}`}
            aria-current={slot.index === current ? "page" : undefined}
            className={`inline-flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-sm px-2 font-mono text-small tabular-nums transition-colors duration-200 ease-ios pointer-coarse:h-11 pointer-coarse:min-w-11 ${slot.index === current ? "nav-active text-accent-nav" : "text-fg-muted hover:bg-surface-3 hover:text-fg-strong"}`}
          >
            {slot.index + 1}
          </button>
        ),
      )}
      {hasMore ? (
        <span aria-hidden="true" className="w-6 text-center font-mono text-small text-fg-subtle">
          …
        </span>
      ) : null}
      <button
        type="button"
        onClick={onNext}
        onPointerEnter={onNextIntent}
        onFocus={onNextIntent}
        disabled={atEnd}
        aria-busy={loadingMore}
        aria-label={loadingMore ? "Loading next page" : "Next page"}
        className={STEP}
      >
        {loadingMore ? (
          <LoaderCircle {...ICON} className="motion-safe:animate-spin" />
        ) : (
          <ChevronRight {...ICON} />
        )}
      </button>
    </nav>
  );
}
