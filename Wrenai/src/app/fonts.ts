import { Geist, Geist_Mono, Inter, Quicksand } from "next/font/google";

// Docs/DESIGN.md → Typography. Variable fonts, self-hosted at build time, Latin only.

export const sansFont = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const signInFont = Geist({
  subsets: ["latin"],
  display: "swap",
});

// The rounded face (font-rounded): the wordmark and popup titles. Its rounded terminals echo the logo's curves.
export const roundedFont = Quicksand({
  subsets: ["latin"],
  variable: "--font-quicksand",
  display: "swap",
});

export const monoFont = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
