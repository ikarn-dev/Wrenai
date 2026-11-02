"use client";

import { KeyRound, type LucideIcon, MessageCircle, ShieldCheck, UserRound } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

interface SettingsTab {
  readonly href: Route;
  readonly label: string;
  readonly icon: LucideIcon;
}

const TABS: readonly SettingsTab[] = [
  { href: "/settings", label: "Account", icon: UserRound },
  { href: "/settings/trading-access", label: "Trading access", icon: KeyRound },
  { href: "/settings/recovery", label: "Recovery", icon: ShieldCheck },
  { href: "/settings/telegram", label: "Telegram", icon: MessageCircle },
];

/**
 * The settings tabs: a vertical list beside the content from `md`, a sideways row above it on narrow screens.
 * Active matches the sidebar's active item (surface-3 pill, nav mint), so both read as "you are here".
 */
export function SettingsNav(): ReactElement {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="min-w-0 md:sticky md:top-6 md:w-52 md:shrink-0 md:self-start">
      <ul className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-9 items-center gap-2.5 rounded-sm px-3 text-body whitespace-nowrap transition-colors duration-200 ease-ios focus-visible:-outline-offset-2 pointer-coarse:h-11 ${active ? "nav-active text-accent-nav" : "text-fg-muted hover:bg-surface-2 hover:text-fg-strong"}`}
              >
                <Icon
                  aria-hidden="true"
                  size={16}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                  className="shrink-0"
                />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
