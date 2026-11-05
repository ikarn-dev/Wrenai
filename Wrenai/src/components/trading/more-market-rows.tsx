import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";

export const MARKET_PAGE_SIZE = 30;

export function MoreMarketRows({
  shown,
  total,
  onMore,
}: {
  readonly shown: number;
  readonly total: number;
  readonly onMore: () => void;
}): ReactElement | null {
  if (shown >= total) {
    return null;
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="font-mono text-caption text-fg-muted tabular-nums">
        {shown} of {total}
      </p>
      <Button type="button" variant="soft" onClick={onMore}>
        Show more
      </Button>
    </div>
  );
}
