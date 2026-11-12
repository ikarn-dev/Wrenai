"use client";

import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { Tooltip } from "radix-ui";
import { type ReactElement, useTransition } from "react";
import { useAppNetwork } from "@/components/shell/network-context";

/** The same round icon-only refresh as Portfolio: arrows turn on hover and spin while the records reload. */
export function RefreshProofButton({ loading }: { readonly loading: boolean }): ReactElement {
  const router = useRouter();
  const network = useAppNetwork();
  const cache = useQueryClient();
  const [pending, startTransition] = useTransition();
  const busy = pending || loading;
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={busy ? "Refreshing proof records" : "Refresh proof records"}
            aria-busy={busy}
            onClick={() =>
              busy
                ? undefined
                : startTransition(async () => {
                    router.refresh();
                    if (network === "testnet") {
                      await cache.invalidateQueries({ queryKey: ["testnet"] });
                    }
                  })
            }
            className="group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center card-shine rounded-full text-fg-muted transition-[color,scale] duration-300 ease-ios hover:text-fg-strong active:scale-92 active:duration-120 aria-busy:text-fg-strong motion-reduce:active:scale-100 pointer-coarse:size-11"
          >
            <RefreshCw
              aria-hidden="true"
              size={15}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className={
                busy
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
            {busy ? "Refreshing" : "Refresh"}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
