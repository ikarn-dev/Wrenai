"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { Tooltip } from "radix-ui";
import { type ReactElement, useTransition } from "react";

/**
 * Icon-only refresh, iOS style: a round lit control (card-shine) that dips on press. Hover turns the arrows a
 * half turn; while the page reloads they spin. Transform only, so it runs on the compositor; reduced motion keeps
 * the icon still.
 */
export function RefreshPortfolioButton(): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={pending ? "Refreshing portfolio" : "Refresh portfolio"}
            aria-busy={pending}
            onClick={() => {
              if (!pending) {
                startTransition(() => router.refresh());
              }
            }}
            className="group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center card-shine rounded-full text-fg-muted transition-[color,scale] duration-300 ease-ios hover:text-fg-strong active:scale-92 active:duration-120 aria-busy:text-fg-strong motion-reduce:active:scale-100 pointer-coarse:size-11"
          >
            <RefreshCw
              aria-hidden="true"
              size={15}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className={
                pending
                  ? "motion-safe:animate-spin"
                  : "transition-transform duration-500 ease-ios motion-safe:group-hover:rotate-180"
              }
            />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={8}
            className="z-40 rounded-xs bg-surface-3 px-2 py-1 text-small text-fg-strong shadow-float"
          >
            {pending ? "Refreshing" : "Refresh"}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
