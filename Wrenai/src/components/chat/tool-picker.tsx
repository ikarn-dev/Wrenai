"use client";

import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactElement } from "react";
import { useAppNetwork } from "@/components/shell/network-context";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { RESEARCH_TOOLS, type ResearchTool } from "@/shared/research";

interface ChatToolPickerProps {
  readonly tools?: readonly ResearchTool[] | undefined;
  readonly value: ResearchTool | null;
  readonly disabled: boolean;
  readonly onChange: (tool: ResearchTool | null) => void;
}

export function ChatToolPicker({
  value,
  disabled,
  onChange,
  tools = activeAgentToolSchema.options,
}: ChatToolPickerProps): ReactElement {
  const network = useAppNetwork();
  const label = (tool: ResearchTool): string =>
    network === "testnet" && tool === "private_payments" ? "Payments" : RESEARCH_TOOLS[tool].label;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/* Radix sets data-state="open" on the trigger, which turns the chevron (group-data-[state=open]). */}
        <button
          type="button"
          disabled={disabled}
          aria-label={`Research tool: ${value ? label(value) : "Auto"}`}
          className={`group inline-flex min-h-9 max-w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 text-small transition-colors duration-200 ease-ios hover:bg-surface-3 data-[state=open]:bg-surface-3 disabled:cursor-not-allowed disabled:text-fg-disabled pointer-coarse:min-h-11 ${value ? "text-accent-text" : "text-fg-muted"}`}
        >
          <SlidersHorizontal
            size={15}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="shrink-0"
          />
          <span className="truncate">{value ? label(value) : "Auto"}</span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="shrink-0 transition-transform duration-300 ease-ios group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          data-lenis-prevent
          className="menu-motion scrollbar-none z-50 max-h-80 min-w-52 max-w-xs overflow-y-auto overscroll-contain card-shine rounded-lg p-1.5 shadow-float"
          style={{ maxHeight: "min(24rem, var(--radix-dropdown-menu-content-available-height))" }}
        >
          <DropdownMenu.Label className="px-3 py-2 text-caption text-fg-subtle">
            Research tools
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value ?? "auto"}
            onValueChange={(next) => {
              if (next === "auto") {
                onChange(null);
              } else {
                const parsed = activeAgentToolSchema.safeParse(next);
                if (parsed.success) {
                  onChange(parsed.data);
                }
              }
            }}
          >
            {[
              { id: "auto", label: "Auto" },
              ...tools.map((tool) => ({
                id: tool,
                label: label(tool),
              })),
            ].map((item) => (
              <DropdownMenu.RadioItem
                key={item.id}
                value={item.id}
                className="relative flex min-h-9 cursor-pointer select-none items-center gap-3 rounded-md py-2 pr-8 pl-3 text-small text-fg-muted outline-none data-highlighted:bg-surface-3 data-highlighted:text-fg-strong data-[state=checked]:text-accent-text pointer-coarse:min-h-11"
              >
                {item.label}
                <DropdownMenu.ItemIndicator className="absolute right-2.5">
                  <Check size={14} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
