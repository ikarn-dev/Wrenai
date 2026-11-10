"use client";

import { ArrowUpRight } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip } from "radix-ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { isNavItemActive, type NavItem } from "./nav-items";

type NavigationView = "expanded" | "collapsed" | "mobile";

interface NavigationTooltipProps {
  readonly label: string;
  readonly shown?: boolean;
  readonly side?: "right" | "top";
  readonly children: ReactNode;
}

export function NavigationTooltip({
  label,
  shown = true,
  side = "right",
  children,
}: NavigationTooltipProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={shown && open} onOpenChange={(next) => setOpen(shown && next)}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className="z-40 max-w-64 rounded-xs bg-surface-3 px-3 py-2 text-small text-fg-strong shadow-float"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const ITEM_BASE =
  "flex min-w-0 items-center rounded-sm text-body transition-colors duration-200 ease-ios focus-visible:-outline-offset-2";
// Clean, like a dashboard sidebar: regular weight throughout. Idle is quiet grey text that only brightens on
// hover; active is the one item on a pill (surface-3) with its label and icon in the calm nav mint.
const ITEM_IDLE = "cursor-pointer text-fg-muted hover:text-fg-strong";
const ITEM_ACTIVE = "cursor-pointer nav-active text-accent-nav";

// Expanded and collapsed share one box, so the icon keeps its left offset while the sidebar's width animates and
// nothing jumps; collapsed only clips and fades the label.
const VIEW_CLASSES: Readonly<Record<NavigationView, string>> = {
  expanded: "h-9 w-full gap-2.5 overflow-hidden px-2.5 pointer-coarse:h-11",
  collapsed: "h-9 w-full gap-2.5 overflow-hidden px-2.5 pointer-coarse:h-11",
  mobile: "min-h-14 w-full flex-col justify-center gap-1 px-1 py-2 text-caption",
};

interface NavigationItemsProps {
  readonly items: readonly NavItem[];
  readonly view: NavigationView;
}

function LinkPending({
  label,
  view,
}: {
  readonly label: string;
  readonly view: NavigationView;
}): ReactElement | null {
  const { pending } = useLinkStatus();
  if (!pending) {
    return null;
  }
  return (
    <span role="status" className="pointer-events-none absolute inset-0">
      <span className="sr-only">Opening {label}</span>
      {view === "expanded" ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-2.5 my-auto size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
        />
      ) : null}
    </span>
  );
}

/** One set of routes, external links and active indicators for the sidebar and mobile navigation. */
export function NavigationItems({ items, view }: NavigationItemsProps): ReactElement {
  const pathname = usePathname();
  return (
    <ul className={`flex gap-0.5 ${view === "mobile" ? "overflow-x-auto" : "flex-col"}`}>
      {items.map((item) => {
        const active = item.kind === "link" && isNavItemActive(pathname, item.href);
        const state = active ? ITEM_ACTIVE : ITEM_IDLE;
        const className = `${ITEM_BASE} ${VIEW_CLASSES[view]} ${state}`;
        const Icon = item.icon;
        const icon = (
          <Icon aria-hidden="true" size={18} strokeWidth={1.5} absoluteStrokeWidth className="shrink-0" />
        );
        const contents = (
          <>
            {icon}
            <span
              aria-hidden={view === "collapsed" ? true : undefined}
              className={`min-w-0 ${view === "mobile" ? "truncate" : `whitespace-nowrap transition-opacity duration-300 ease-ios motion-reduce:transition-none ${view === "collapsed" ? "opacity-0" : "opacity-100"}`}`}
            >
              {item.label}
            </span>
            {item.kind === "external" && view !== "mobile" ? (
              // Opens another site in a new tab, so the arrow says so before the click.
              <ArrowUpRight
                aria-hidden="true"
                size={14}
                strokeWidth={1.75}
                absoluteStrokeWidth
                className={`ml-auto shrink-0 text-fg-subtle transition-opacity duration-300 ease-ios motion-reduce:transition-none ${view === "collapsed" ? "opacity-0" : "opacity-100"}`}
              />
            ) : null}
          </>
        );
        return (
          <li key={item.label} className={view === "mobile" ? "min-w-14 shrink-0 flex-1" : ""}>
            <NavigationTooltip
              label={item.label}
              shown={view === "collapsed"}
              side={view === "mobile" ? "top" : "right"}
            >
              {item.kind === "link" ? (
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label={view === "collapsed" ? item.label : undefined}
                  className={`relative ${className}`}
                >
                  {contents}
                  <LinkPending label={item.label} view={view} />
                </Link>
              ) : (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${item.label} (opens in a new tab)`}
                  className={`relative ${className}`}
                >
                  {contents}
                </a>
              )}
            </NavigationTooltip>
          </li>
        );
      })}
    </ul>
  );
}
