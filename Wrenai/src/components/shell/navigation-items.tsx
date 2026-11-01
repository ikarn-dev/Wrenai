"use client";

import { m } from "motion/react";
import Link from "next/link";
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
  "flex min-w-0 items-center rounded-xs text-body transition-colors duration-200 ease-ios focus-visible:-outline-offset-2";
// Clean, like a dashboard sidebar: regular weight throughout. Idle is quiet grey text that only brightens on
// hover; active is the one item on a pill, the next surface step up (surface-2), with strong text.
const ITEM_IDLE = "cursor-pointer text-fg-muted hover:text-fg-strong";
const ITEM_ACTIVE = "cursor-pointer nav-active text-fg-strong";
const ITEM_UNAVAILABLE = "cursor-not-allowed text-fg-disabled";

const VIEW_CLASSES: Readonly<Record<NavigationView, string>> = {
  expanded: "h-9 w-full gap-2.5 px-2.5 pointer-coarse:h-11",
  collapsed: "size-10 justify-center pointer-coarse:size-11",
  mobile: "min-h-14 w-full flex-col justify-center gap-1 px-1 py-2 text-caption",
};

interface NavigationItemsProps {
  readonly items: readonly NavItem[];
  readonly view: NavigationView;
}

/** One set of routes, unavailable states and active indicators for the sidebar and mobile navigation. */
export function NavigationItems({ items, view }: NavigationItemsProps): ReactElement {
  const pathname = usePathname();
  return (
    <ul
      className={`flex gap-0.5 ${view === "mobile" ? "" : view === "collapsed" ? "flex-col items-center" : "flex-col"}`}
    >
      {items.map((item) => {
        const active = item.kind === "link" && isNavItemActive(pathname, item.href);
        const state = item.kind === "unavailable" ? ITEM_UNAVAILABLE : active ? ITEM_ACTIVE : ITEM_IDLE;
        const className = `${ITEM_BASE} ${VIEW_CLASSES[view]} ${state}`;
        const Icon = item.icon;
        const icon = (
          <Icon aria-hidden="true" size={18} strokeWidth={1.5} absoluteStrokeWidth className="shrink-0" />
        );
        const contents = (
          <>
            {view === "mobile" ? (
              icon
            ) : (
              <m.span layout="position" initial={false} className="inline-flex size-5 shrink-0">
                {icon}
              </m.span>
            )}
            <span
              aria-hidden={view === "collapsed" ? true : undefined}
              className={`min-w-0 truncate ${view === "mobile" ? "" : "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-ios"} ${view === "collapsed" ? "pointer-events-none absolute left-11 -translate-x-2 opacity-0" : "translate-x-0 opacity-100"}`}
            >
              {item.label}
            </span>
            {item.kind === "unavailable" && view === "expanded" ? (
              <span aria-hidden="true" className="ml-auto shrink-0 text-caption text-fg-subtle">
                Not built
              </span>
            ) : null}
          </>
        );
        return (
          <li key={item.label} className={view === "mobile" ? "min-w-0 flex-1" : ""}>
            <NavigationTooltip
              label={item.kind === "link" ? item.label : `${item.label} is not built yet`}
              shown={view === "collapsed" || item.kind === "unavailable"}
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
                </Link>
              ) : (
                // aria-disabled keeps the explanation reachable by keyboard; there is no action or route.
                <button
                  type="button"
                  aria-disabled="true"
                  aria-label={`${item.label} is not built yet`}
                  className={`relative ${className}`}
                >
                  {contents}
                </button>
              )}
            </NavigationTooltip>
          </li>
        );
      })}
    </ul>
  );
}
