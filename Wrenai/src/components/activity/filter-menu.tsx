"use client";

import { BrainCircuit, Check, ChevronDown, Layers, type LucideIcon, Wallet } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactElement } from "react";
import { type ActivityFilter, activityFilterSchema } from "@/shared/activity";

const ICON = { "aria-hidden": true, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

const OPTIONS: Readonly<Record<ActivityFilter, { readonly label: string; readonly icon: LucideIcon }>> = {
  all: { label: "All activity", icon: Layers },
  wallet: { label: "Wallet", icon: Wallet },
  agents: { label: "Agents", icon: BrainCircuit },
};

interface ActivityFilterMenuProps {
  readonly value: ActivityFilter;
  readonly onChange: (filter: ActivityFilter) => void;
}

/** The activity source filter as one dropdown: the trigger names the current view, the menu lists all three. */
export function ActivityFilterMenu({ value, onChange }: ActivityFilterMenuProps): ReactElement {
  const Current = OPTIONS[value].icon;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Show: ${OPTIONS[value].label}`}
          className="group inline-flex h-8 cursor-pointer items-center gap-2 rounded-sm bg-surface-3 pr-2.5 pl-3 text-small font-medium text-fg-strong ring-1 ring-line-strong/50 ring-inset transition-colors duration-200 ease-ios hover:bg-surface-4 data-[state=open]:bg-surface-4 pointer-coarse:h-11"
        >
          <Current {...ICON} size={14} className="shrink-0 text-fg-muted" />
          {OPTIONS[value].label}
          <ChevronDown
            {...ICON}
            size={13}
            className="shrink-0 text-fg-muted transition-transform duration-300 ease-ios group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="menu-motion z-50 min-w-48 card-shine rounded-md p-1.5 shadow-float"
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-caption text-fg-subtle">Show</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => {
              const parsed = activityFilterSchema.safeParse(next);
              if (parsed.success) {
                onChange(parsed.data);
              }
            }}
          >
            {activityFilterSchema.options.map((id) => {
              const Icon = OPTIONS[id].icon;
              return (
                <DropdownMenu.RadioItem
                  key={id}
                  value={id}
                  className="group relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-xs py-2 pr-8 pl-2.5 text-small text-fg-muted outline-none data-highlighted:bg-surface-3 data-highlighted:text-fg-strong data-[state=checked]:text-fg-strong pointer-coarse:min-h-11"
                >
                  <Icon {...ICON} size={14} className="shrink-0 group-data-[state=checked]:text-accent-nav" />
                  {OPTIONS[id].label}
                  <DropdownMenu.ItemIndicator className="absolute right-2.5 text-accent-nav">
                    <Check {...ICON} size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
