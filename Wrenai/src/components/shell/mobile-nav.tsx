"use client";

import { Tooltip } from "radix-ui";
import type { ReactElement } from "react";
import { NAV_ITEMS } from "./nav-items";
import { NavigationItems } from "./navigation-items";

/** Below lg: the nav as a floating bar at the bottom of the screen, a floating layer on surface-2. */
export function MobileNav(): ReactElement {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-gutter bottom-3 z-10 mx-auto mb-[env(safe-area-inset-bottom)] max-w-sm rounded-xl border border-line bg-surface-2 p-1.5 lg:hidden"
    >
      <Tooltip.Provider delayDuration={300}>
        <NavigationItems items={NAV_ITEMS.filter((item) => item.kind === "link")} view="mobile" />
      </Tooltip.Provider>
    </nav>
  );
}
