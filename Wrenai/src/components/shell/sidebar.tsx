"use client";

import { BookOpen, ChevronsLeft, ChevronsRight } from "lucide-react";
import Link from "next/link";
import { Tooltip } from "radix-ui";
import { memo, type ReactElement, useId, useMemo } from "react";
import { networkRoute } from "@/shared/app-routes";
import { SIDEBAR_COOKIE } from "@/shared/sidebar";
import { Brand } from "./brand";
import { NAV_ITEMS, type NavItem } from "./nav-items";
import { NavigationItems, NavigationTooltip } from "./navigation-items";
import { useAppNetwork } from "./network-context";

const MAIN_ITEMS = NAV_ITEMS.filter((item) => item.group === "main");
const MARKET_ITEMS = NAV_ITEMS.filter((item) => item.group === "markets");
const SETTINGS_ITEMS = NAV_ITEMS.filter((item) => item.group === "settings");
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Stores the width for the next full load, in the browser: no request, so nothing to fail or show. Uses the
 * Cookie Store API (every current browser; it needs a secure context, which includes localhost). Without it the
 * width still applies for this visit and the next load opens expanded, which is harmless, so there is no notice.
 */
function rememberWidth(collapsed: boolean): void {
  if (!("cookieStore" in window)) {
    return;
  }
  void window.cookieStore
    .set({
      name: SIDEBAR_COOKIE,
      value: collapsed ? "collapsed" : "expanded",
      path: "/",
      sameSite: "lax",
      expires: Date.now() + ONE_YEAR_MS,
    })
    .catch(() => {
      // Only the next load's width depends on this; the current width already changed.
      return undefined;
    });
}
const TOGGLE =
  "absolute inset-y-0 my-auto inline-flex shrink-0 cursor-pointer items-center justify-center text-fg-muted transition-[right,background-color,color] duration-[420ms] ease-ios hover:bg-surface-3 hover:text-fg-strong motion-reduce:transition-none";
// Collapsed, the toggle is a small circle just outside the card's edge (6 px gap), so it never covers the mark.
const TOGGLE_EXPANDED = "right-1 size-9 rounded-sm pointer-coarse:size-11";
const TOGGLE_COLLAPSED =
  "-right-8.5 size-7 rounded-full bg-surface-card ring-1 ring-line-card ring-inset pointer-coarse:-right-12.5 pointer-coarse:size-11";

const FADE = "transition-opacity duration-300 ease-ios motion-reduce:transition-none";

/**
 * A section's label. The row keeps one height in both widths: the label fades out as the sidebar narrows and a
 * short rule fades in, so nothing below it moves. The first section shows no rule when collapsed.
 */
function SectionLabel({
  label,
  collapsed,
  first = false,
}: {
  readonly label: string;
  readonly collapsed: boolean;
  readonly first?: boolean;
}): ReactElement {
  return (
    <div
      className={`relative flex h-7 items-center px-2.5 ${first ? "mb-1" : "mt-3 mb-1"}`}
      aria-hidden={collapsed ? true : undefined}
    >
      <span
        className={`text-caption font-medium whitespace-nowrap text-fg-subtle ${FADE} ${collapsed ? "opacity-0" : "opacity-100"}`}
      >
        {label}
      </span>
      {first ? null : (
        <span
          className={`absolute inset-x-3 top-1/2 h-px bg-line-card ${FADE} ${collapsed ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly docsUrl: string;
}

/** Route subscribers live in NavigationItems; the frame only updates when its width changes. */
function SidebarView({ collapsed, onCollapsedChange, docsUrl }: SidebarProps): ReactElement {
  const network = useAppNetwork();
  const navigationId = useId();
  const settingsItems = useMemo(
    (): readonly NavItem[] => [
      ...SETTINGS_ITEMS,
      { kind: "external", href: docsUrl, label: "Documentation", icon: BookOpen, group: "settings" },
    ],
    [docsUrl],
  );
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const ToggleIcon = collapsed ? ChevronsRight : ChevronsLeft;

  function toggle(): void {
    const next = !collapsed;
    onCollapsedChange(next);
    rememberWidth(next);
  }

  // The card's own width animates (420 ms, ease-ios), not a transform: the page beside it is a flex sibling, so
  // a transformed sidebar would leave the page snapping to its new width and centered content jumping. Icons, the
  // logo mark and the labels keep one left offset in both widths, so only the edge moves; labels and the
  // wordmark are clipped as it narrows. Reduced motion switches at once.
  return (
    <aside aria-label="Sidebar" className="sticky top-0 z-20 hidden h-dvh shrink-0 py-3 lg:block">
      <Tooltip.Provider delayDuration={300}>
        <div
          className={`relative flex h-full min-h-0 flex-col card-shine rounded-md p-2 transition-[width] duration-[420ms] ease-ios motion-reduce:transition-none ${collapsed ? "w-14" : "w-60"}`}
        >
          <div className="relative flex h-10 w-full shrink-0 items-center pointer-coarse:h-11">
            <Link
              href={networkRoute(network, "/portfolio")}
              className="flex h-10 min-w-0 flex-1 items-center overflow-hidden rounded-sm px-1.5 pointer-coarse:min-h-11"
            >
              <Brand size="md" markOnly={collapsed} />
            </Link>
            <NavigationTooltip label={toggleLabel}>
              <button
                type="button"
                onClick={toggle}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                aria-controls={navigationId}
                className={`${TOGGLE} ${collapsed ? TOGGLE_COLLAPSED : TOGGLE_EXPANDED}`}
              >
                <ToggleIcon
                  aria-hidden="true"
                  size={collapsed ? 16 : 18}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                />
              </button>
            </NavigationTooltip>
          </div>
          <nav
            id={navigationId}
            aria-label="Primary"
            className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line-card pt-2"
          >
            <div data-lenis-prevent className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <SectionLabel label="Platform" collapsed={collapsed} first />
              <NavigationItems items={MAIN_ITEMS} view={collapsed ? "collapsed" : "expanded"} />
              <SectionLabel label="Markets" collapsed={collapsed} />
              <NavigationItems items={MARKET_ITEMS} view={collapsed ? "collapsed" : "expanded"} />
            </div>
            <div className="flex shrink-0 flex-col gap-0.5 border-t border-line-card pt-2">
              <NavigationItems items={settingsItems} view={collapsed ? "collapsed" : "expanded"} />
            </div>
          </nav>
        </div>
      </Tooltip.Provider>
    </aside>
  );
}

export const Sidebar = memo(SidebarView);
