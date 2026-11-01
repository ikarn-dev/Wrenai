"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { Tooltip } from "radix-ui";
import { type ReactElement, useCallback, useId, useState } from "react";
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

function SidebarSurface(): ReactElement {
  const [radius, setRadius] = useState("var(--radius-md)");
  const readRadius = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) {
      // Resolve the theme token so Motion keeps the corners round while the surface changes width.
      setRadius(getComputedStyle(node).borderTopLeftRadius);
    }
  }, []);
  return (
    <m.div
      ref={readRadius}
      layout
      initial={false}
      aria-hidden="true"
      style={{ borderRadius: radius }}
      className="pointer-events-none absolute inset-0 -z-10 card-shine rounded-md"
    />
  );
}

/** The desktop navigation card, with its initial width read on the server to avoid a flash on reload. */
export function Sidebar({ initiallyCollapsed }: { readonly initiallyCollapsed: boolean }): ReactElement {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const navigationId = useId();
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const ToggleIcon = collapsed ? ChevronsRight : ChevronsLeft;

  function toggle(): void {
    const next = !collapsed;
    setCollapsed(next);
    rememberWidth(next);
  }

  return (
    <aside aria-label="Sidebar" className="sticky top-0 z-20 hidden h-dvh shrink-0 py-3 lg:block">
      <Tooltip.Provider delayDuration={300}>
        <div
          className={`relative isolate flex h-full min-h-0 flex-col rounded-md p-2 ${collapsed ? "w-18" : "w-60"}`}
        >
          <SidebarSurface />
          {/* Collapsed, the mark centers on the same axis as the nav icons below it. */}
          <div
            className={`relative flex h-10 w-full shrink-0 items-center pointer-coarse:h-11 ${collapsed ? "justify-center" : "justify-start"}`}
          >
            <m.div layout="position" initial={false} className="shrink-0">
              <Link
                href="/portfolio"
                className={`flex h-10 items-center justify-center rounded-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${collapsed ? "w-10" : "px-2.5"}`}
              >
                <Brand size="md" markOnly={collapsed} />
              </Link>
            </m.div>
            <NavigationTooltip label={toggleLabel}>
              <m.button
                layout="position"
                initial={false}
                type="button"
                onClick={toggle}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                aria-controls={navigationId}
                className={`${CONTROL} absolute inset-y-0 my-auto ${collapsed ? "-right-6.5 rounded-full bg-surface-card pointer-coarse:-right-7.5" : "right-1 rounded-sm"}`}
              >
                <ToggleIcon aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth />
              </m.button>
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
