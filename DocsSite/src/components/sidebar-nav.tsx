"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { NAVIGATION } from "@/docs/navigation";

/** The current page's path without a trailing slash, as the sidebar's links write it. */
export function currentPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

/**
 * The page list, grouped like the app's sidebar: a mono eyebrow per group, then quiet links. The current page sits on
 * the surface-3 pill with its label in the nav mint, like the app's active item. Shared by the desktop sidebar and the
 * mobile menu.
 */
export function SidebarNav({ onNavigate }: { readonly onNavigate?: () => void }): ReactElement {
  const pathname = currentPath(usePathname());
  return (
    <nav aria-label="Documentation" className="flex flex-col gap-7">
      {NAVIGATION.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5">
          <p className="px-3 font-mono text-eyebrow text-fg-subtle uppercase">{group.title}</p>
          <ul className="flex flex-col gap-0.5">
            {group.pages.map((page) => {
              const active = page.href === pathname;
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-8 items-center rounded-sm px-3 py-1.5 text-small transition-colors duration-200 ease-ios focus-visible:-outline-offset-2 pointer-coarse:min-h-11 ${active ? "nav-active font-medium text-accent-nav" : "text-fg-muted hover:text-fg-strong"}`}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
