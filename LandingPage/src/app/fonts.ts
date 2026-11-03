import { Outfit, Quicksand } from "next/font/google";

// Variable fonts, self-hosted at build time, Latin only (Docs/DESIGN.md → Font loading). The landing page uses a
// round geometric sans (circular o, c and e) for its headline and text; Quicksand stays for the wordmark only.
// Nothing else loads, since each extra font file costs first paint.
export const sansFont = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

export const roundedFont = Quicksand({
  subsets: ["latin"],
  weight: "700",
  variable: "--font-quicksand",
  display: "swap",
});
