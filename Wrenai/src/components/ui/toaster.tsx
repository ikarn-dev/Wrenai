"use client";

import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { ReactElement } from "react";
import { Toaster as Sonner } from "sonner";

const ICON = { size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

/**
 * The one toast region (Docs/DESIGN.md → Components → Toasts): bottom right, above the mobile nav bar, in the card
 * style. Sonner is unstyled here so every toast uses the app's tokens; the tone shows in the icon only.
 */
export function Toaster(): ReactElement {
  return (
    <Sonner
      position="bottom-right"
      theme="dark"
      offset={24}
      mobileOffset={{ bottom: 96 }}
      visibleToasts={3}
      gap={8}
      duration={5000}
      closeButton
      icons={{
        success: <CircleCheck {...ICON} className="text-accent-text" />,
        info: <Info {...ICON} className="text-fg-muted" />,
        warning: <TriangleAlert {...ICON} className="text-warn" />,
        error: <CircleAlert {...ICON} className="text-loss" />,
        loading: <LoaderCircle {...ICON} className="text-fg-muted motion-safe:animate-spin" />,
        close: <X size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-[min(22rem,calc(100vw-2rem))] items-start gap-3 card-shine rounded-lg px-4 py-3 text-small text-fg-strong shadow-float",
          icon: "mt-px shrink-0",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "text-small text-fg-strong",
          description: "text-caption text-fg-muted",
          actionButton:
            "ml-2 h-7 shrink-0 cursor-pointer rounded-sm bg-surface-3 px-2.5 text-caption font-medium text-fg-strong hover:bg-surface-4",
          cancelButton: "ml-2 h-7 shrink-0 cursor-pointer rounded-sm px-2.5 text-caption text-fg-muted",
          // Unstyled toasts render the close button first in the row; `order-last` moves it to the trailing edge.
          closeButton:
            "order-last -my-0.5 -mr-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors duration-300 ease-ios hover:bg-surface-3 hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-accent",
        },
      }}
    />
  );
}
