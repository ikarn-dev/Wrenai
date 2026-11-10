import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SmoothScroll } from "@/components/motion/smooth-scroll";
import { roundedFont, sansFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  // The tab shows the name alone; the icon is app/icon.png (Next's file convention), the cropped logo mark.
  title: "Wrenai",
  description:
    "Research NEAR markets with Jarvis, then turn a plan into an agent. Every trade passes a Guard the model can't override.",
};

// The page grounds of both themes (void-900 dark, void-100 light), following the device setting.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
    { media: "(prefers-color-scheme: light)", color: "#ededed" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    // public/theme.js sets data-theme on <html> before hydration, so React is told not to expect it.
    <html lang="en" className={`${sansFont.variable} ${roundedFont.variable}`} suppressHydrationWarning>
      <head>
        {/* Blocking on purpose: it must run before the body paints, or a light visit would flash dark. A static
            file rather than an inline script, so no HTML is injected. */}
        <script src="/theme.js" />
      </head>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        {/* Vercel Web Analytics: cookieless page views, sent to /_vercel/insights on a Vercel deployment once Web
            Analytics is enabled for the project. Outside Vercel it logs in development and sends nothing. */}
        <Analytics />
      </body>
    </html>
  );
}
