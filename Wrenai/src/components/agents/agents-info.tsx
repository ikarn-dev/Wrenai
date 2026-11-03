"use client";

import { Info } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactElement } from "react";

/**
 * Which agent types can trade, in user terms. No runtime or backend details:
 * those stay in EXECUTION_UNAVAILABLE for the agent detail page.
 */
export function AgentsInfo(): ReactElement {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label="Which agents can trade"
            className="inline-flex size-8 cursor-default items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
          >
            <Info size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="z-50 max-w-60 card-shine rounded-md px-3 py-2.5 text-caption text-fg-muted shadow-float"
          >
            Funded agents need your authorization before trading. Meme Hunter stays blocked until its required
            token checks can be verified. Whale Tracker sends alerts only.
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
