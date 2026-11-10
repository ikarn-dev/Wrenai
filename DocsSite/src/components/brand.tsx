import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";
import logo from "../../public/assets/nobg_logo.png";

/** The app's brand row (Docs/DESIGN.md → Wordmark) with "Docs" after a hairline, linking to the introduction. */
export function Brand(): ReactElement {
  return (
    <Link href="/" aria-label="Wrenai Docs home" className="flex shrink-0 items-center gap-2.5 rounded-sm">
      {/* The file is cropped to the mark's edges, so the gap comes from CSS. */}
      <Image src={logo} alt="" height={26} loading="eager" className="h-6.5 w-auto shrink-0" />
      <span aria-hidden="true" className="font-rounded text-h2 font-bold text-fg-strong">
        Wren<span className="text-accent-text">ai</span>
      </span>
      <span aria-hidden="true" className="h-4 w-px bg-line-card" />
      <span aria-hidden="true" className="text-body font-medium text-fg-muted">
        Docs
      </span>
    </Link>
  );
}
