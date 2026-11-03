import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SmoothScroll } from "@/components/motion/smooth-scroll";
import { roundedFont, sansFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wrenai: private AI for your DeFi",
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
      </body>
    </html>
  );
}
