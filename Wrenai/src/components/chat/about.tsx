"use client";
import { Ban, Eye, Info, Lock } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactElement } from "react";

const INFO_LINES = [
  { icon: Eye, text: "Sees your wallet and agents" },
  { icon: Ban, text: "Trade previews need your confirmation" },
  { icon: Lock, text: "Chats stored encrypted" },
] as const;
export function JarvisAbout(): ReactElement | null {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label="About Jarvis"
            className="inline-flex size-9 cursor-default items-center justify-center rounded-sm text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
          >
            <Info size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="z-50 card-shine rounded-md px-3 py-2.5 text-caption text-fg-muted shadow-float"
          >
            <ul className="flex flex-col gap-1.5">
              {INFO_LINES.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-2 whitespace-nowrap">
                  <Icon
                    size={12}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    aria-hidden="true"
                    className="shrink-0 text-fg-subtle"
                  />
                  {text}
                </li>
              ))}
            </ul>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
