import { Plus_Jakarta_Sans, Quicksand } from "next/font/google";

// Variable fonts, self-hosted at build time, Latin only (Docs/DESIGN.md → Font loading). The landing page uses a
// geometric sans for its headline and text; Quicksand stays for the wordmark only. Nothing else loads, since each
// extra font file costs first paint.
export const sansFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

export const roundedFont = Quicksand({
  subsets: ["latin"],
  weight: "700",
  variable: "--font-quicksand",
  display: "swap",
});
