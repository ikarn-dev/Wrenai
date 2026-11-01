"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import Link from "next/link";
import { Tooltip } from "radix-ui";
import { memo, type ReactElement, useId } from "react";
import { SIDEBAR_COOKIE } from "@/shared/sidebar";
import { Brand } from "./brand";
import { NAV_ITEMS } from "./nav-items";
import { NavigationItems, NavigationTooltip } from "./navigation-items";

const MAIN_ITEMS = NAV_ITEMS.filter((item) => item.group === "main");
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
const CONTROL =
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center text-fg-muted transition-colors duration-300 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11";

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}

/** Route subscribers live in NavigationItems; the frame only updates when its width changes. */
function SidebarView({ collapsed, onCollapsedChange }: SidebarProps): ReactElement {
  const navigationId = useId();
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
              href="/portfolio"
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
                className={`${CONTROL} absolute inset-y-0 my-auto transition-[right,background-color,color] duration-[420ms] ease-ios motion-reduce:transition-none ${collapsed ? "-right-6.5 rounded-full bg-surface-card pointer-coarse:-right-7.5" : "right-1 rounded-sm"}`}
              >
                <ToggleIcon aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth />
              </button>
            </NavigationTooltip>
          </div>
          {/* Groups are separated by thin rules, not labels (Docs/DESIGN.md → App shell). */}
          <nav
            id={navigationId}
            aria-label="Primary"
            className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line-card pt-2"
          >
            <div data-lenis-prevent className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <NavigationItems items={MAIN_ITEMS} view={collapsed ? "collapsed" : "expanded"} />
            </div>
            <div className="flex shrink-0 flex-col gap-0.5 border-t border-line-card pt-2">
              <NavigationItems items={SETTINGS_ITEMS} view={collapsed ? "collapsed" : "expanded"} />
            </div>
          </nav>
        </div>
      </Tooltip.Provider>
    </aside>
  );
}

export const Sidebar = memo(SidebarView);
