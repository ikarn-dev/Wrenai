import Image from "next/image";
import type { ReactElement } from "react";
import logo from "../../../public/assets/nobg_logo.png";

// The nav's size, and a larger one for the footer: mark 28 → 36 px, wordmark 24 → 32 px.
const SIZES = {
  md: { text: "text-h2 gap-1.5", mark: "h-brand", height: 28 },
  lg: { text: "text-brand-lg gap-2", mark: "h-brand-lg", height: 36 },
} as const;

/** The logo mark and the "Wrenai" wordmark, "ai" in the accent color, as in the app (Docs/DESIGN.md → Wordmark). */
export function Brand({ size = "md" }: { readonly size?: keyof typeof SIZES }): ReactElement {
  const scale = SIZES[size];
  return (
    <span className={`inline-flex items-center text-fg-strong ${scale.text}`}>
      {/* The name sits beside the mark, so the image adds nothing for screen readers. The file is cropped to the
          mark's edges, so the gap comes from CSS. */}
      <Image
        src={logo}
        alt=""
        height={scale.height}
        loading="eager"
        className={`${scale.mark} w-auto shrink-0`}
      />
      <span aria-hidden="true" className="font-rounded font-bold">
        Wren<span className="text-accent-text">ai</span>
      </span>
      <span className="sr-only">Wrenai</span>
    </span>
  );
}
