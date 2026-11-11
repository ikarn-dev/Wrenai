"use client";

import { KeyRound, type LucideIcon, ShieldCheck, UserRound } from "lucide-react";
import { usePathname } from "next/navigation";
import type { MouseEvent, ReactElement, ReactNode } from "react";

export type SettingsTabId = "account" | "trading" | "recovery";

interface SettingsTab {
  readonly id: SettingsTabId;
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const TABS: readonly SettingsTab[] = [
  { id: "account", href: "/settings", label: "Account", icon: UserRound },
  { id: "trading", href: "/settings/trading-access", label: "Trading access", icon: KeyRound },
  { id: "recovery", href: "/settings/recovery", label: "Recovery", icon: ShieldCheck },
];

/** A plain left click switches in place; a modified click (new tab, new window) keeps the browser's behavior. */
function switchInPlace(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  if (window.location.pathname !== href) {
    // Next syncs native pushState with usePathname, so the URL, Back and the active tab stay in step.
    window.history.pushState(null, "", href);
  }
}

/**
 * Settings tabs that switch without a server round trip: every panel is rendered once by the server and the URL
 * changes through the History API, so a switch is instant and never refetches or remounts a panel. Each tab URL is
 * still a real route for deep links and reloads.
 */
export function SettingsTabs({
  panels,
}: {
  readonly panels: Readonly<Record<SettingsTabId, ReactNode>>;
}): ReactElement {
  const pathname = usePathname();
  const active = TABS.find((tab) => tab.href === pathname)?.id ?? "account";
  return (
    <div className="flex min-w-0 flex-col gap-6 md:flex-row md:gap-10">
      <nav aria-label="Settings" className="min-w-0 md:sticky md:top-6 md:w-48 md:shrink-0 md:self-start">
        <ul className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
          {TABS.map((tab) => {
            const current = tab.id === active;
            const Icon = tab.icon;
            return (
              <li key={tab.id} className="shrink-0">
                <a
                  href={tab.href}
                  onClick={(event) => switchInPlace(event, tab.href)}
                  aria-current={current ? "page" : undefined}
                  className={`flex h-9 items-center gap-2.5 rounded-sm px-3 text-body whitespace-nowrap transition-colors duration-200 ease-ios focus-visible:-outline-offset-2 pointer-coarse:h-11 ${current ? "nav-active text-accent-nav" : "text-fg-muted hover:bg-surface-2 hover:text-fg-strong"}`}
                >
                  <Icon
                    aria-hidden="true"
                    size={16}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    className="shrink-0"
                  />
                  {tab.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 max-w-reading flex-1">
        {TABS.map((tab) => (
          <div key={tab.id} hidden={tab.id !== active}>
            {panels[tab.id]}
          </div>
        ))}
      </div>
    </div>
  );
}
