import Image from "next/image";
import type { ReactElement } from "react";
import logo from "../../../public/assets/nobg_logo.png";

/** The logo mark and the "Wrenai" wordmark, "ai" in the accent color, as in the app (Docs/DESIGN.md → Wordmark). */
export function Brand(): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-h2 text-fg-strong">
      {/* The name sits beside the mark, so the image adds nothing for screen readers. The file is cropped to the
          mark's edges, so the gap comes from CSS. */}
      <Image src={logo} alt="" height={28} loading="eager" className="h-brand w-auto shrink-0" />
      <span aria-hidden="true" className="font-rounded font-bold">
        Wren<span className="text-accent-text">ai</span>
      </span>
      <span className="sr-only">Wrenai</span>
    </span>
  );
}
