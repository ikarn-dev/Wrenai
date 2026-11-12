import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { SmoothScroll } from "@/components/motion/smooth-scroll";
import { Toaster } from "@/components/ui/toaster";
import { monoFont, roundedFont, sansFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Wrenai", template: "%s · Wrenai" },
  icons: { icon: { url: "/assets/nobg_logo.png", type: "image/png" } },
  description:
    "Private AI agents for DeFi on NEAR. Strategies are reasoned inside a TEE, and every trade passes a Guard the model can't override.",
};

export const viewport: Viewport = {
  themeColor: "#121212",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Every page renders per request, so each gets the nonce from src/proxy.ts. A prerendered page would carry
  // scripts without it, and the CSP would block them.
  await connection();
  return (
    <html lang="en" className={`${sansFont.variable} ${monoFont.variable} ${roundedFont.variable}`}>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        <Toaster />
      </body>
    </html>
  );
}
