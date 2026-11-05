import type { ReactElement } from "react";
import { EMPTY_AGENTS_CARD } from "./agents-header";

const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";

export function AgentListSkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading your agents" className={EMPTY_AGENTS_CARD}>
      <span aria-hidden="true" className={`${BLOCK} size-5 rounded-full`} />
      <span aria-hidden="true" className={`${BLOCK} h-lh w-28 text-body`} />
      <span aria-hidden="true" className={`${BLOCK} h-lh w-52 text-small`} />
    </div>
  );
}
