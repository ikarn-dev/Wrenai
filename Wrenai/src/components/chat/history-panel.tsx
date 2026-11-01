"use client";

import { PanelLeftOpen } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

interface ChatHistoryPanelProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}

const RAIL_BUTTON =
  "inline-flex size-9 cursor-pointer items-center justify-center rounded-lg-inset text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11";

// Both layers stay mounted and crossfade, so nothing pops in or out; the hidden one is inert (no focus, no clicks).
const LAYER =
  "absolute inset-y-2 left-2 transition-opacity duration-300 ease-ios motion-reduce:transition-none";

/**
 * The chat history card (xl and up), collapsible to a slim rail. The card's own width animates (420 ms, ease-ios),
 * not a transform: the thread beside it is a flex sibling, so a transformed panel would leave it snapping to its
 * new width and its centered content jumping. Animating width lets the thread reflow every frame and glide. The
 * full list keeps its 240 px width and is clipped while the card narrows, so its text never rewraps mid-motion.
 */
export function ChatHistoryPanel({ collapsed, onToggle, children }: ChatHistoryPanelProps): ReactElement {
  return (
    <aside
      aria-label="Chat history"
      className={`relative hidden shrink-0 overflow-hidden card-shine rounded-lg transition-[width] duration-[420ms] ease-ios motion-reduce:transition-none xl:block ${collapsed ? "w-14" : "w-64"}`}
    >
      <div inert={collapsed} className={`${LAYER} right-2 w-60 ${collapsed ? "opacity-0" : "opacity-100"}`}>
        {children}
      </div>
      <div inert={!collapsed} className={`${LAYER} ${collapsed ? "opacity-100" : "opacity-0"}`}>
        <Tooltip.Provider delayDuration={300}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button type="button" aria-label="Show chat history" onClick={onToggle} className={RAIL_BUTTON}>
                <PanelLeftOpen size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="right"
                sideOffset={8}
                className="z-40 rounded-xs bg-surface-3 px-2 py-1 text-small text-fg-strong shadow-float"
              >
                Show chats
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>
    </aside>
  );
}
