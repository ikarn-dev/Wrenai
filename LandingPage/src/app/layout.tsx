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

export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${sansFont.variable} ${roundedFont.variable}`}>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        {/* Vercel Web Analytics: cookieless page views, sent to /_vercel/insights on a Vercel deployment once Web
            Analytics is enabled for the project. Outside Vercel it logs in development and sends nothing. */}
        <Analytics />
      </body>
    </html>
  );
}
