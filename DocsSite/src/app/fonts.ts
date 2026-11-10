import { Geist_Mono, Inter, Quicksand } from "next/font/google";

// The app's faces (Docs/DESIGN.md → Typography): Inter for text, Geist Mono for code and data, Quicksand for the
// wordmark only. Variable fonts, self-hosted at build time, Latin only.
export const sansFont = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const monoFont = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const roundedFont = Quicksand({
  subsets: ["latin"],
  weight: "700",
  variable: "--font-quicksand",
  display: "swap",
});
