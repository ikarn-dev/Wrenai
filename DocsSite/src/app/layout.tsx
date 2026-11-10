import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SidebarNav } from "@/components/sidebar-nav";
import { SiteHeader } from "@/components/site-header";
import { monoFont, roundedFont, sansFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  // The icon is app/icon.png (Next's file convention), the cropped logo mark.
  title: { default: "Wrenai Docs", template: "%s · Wrenai Docs" },
  description: "How to research with Jarvis, run agents and keep control of your funds in Wrenai.",
};

export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  colorScheme: "dark",
};

/** The docs frame: the header across the top, the sidebar on the left from lg, each page beside it. */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${sansFont.variable} ${monoFont.variable} ${roundedFont.variable}`}>
      <body>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-small"
        >
          Skip to content
        </a>
        <SiteHeader />
        <div className="mx-auto flex max-w-app gap-10 px-gutter">
          <aside className="sticky top-header hidden h-[calc(100dvh-var(--spacing-header))] w-60 shrink-0 overflow-y-auto overscroll-contain py-10 lg:block">
            <SidebarNav />
          </aside>
          <main id="content" className="flex min-w-0 flex-1">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
