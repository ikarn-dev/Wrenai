import Image from "next/image";
import type { ReactElement } from "react";
import logo from "../../../public/assets/nobg_logo.png";

interface JarvisMarkProps {
  readonly size: number;
  readonly className?: string;
  /**
   * Split into the outer ring and the inner eye, so the ring can rotate around a still eye while Jarvis works
   * (globals.css → Jarvis mark). The two layers are the same image under complementary masks, so at rest they
   * reassemble the logo exactly.
   */
  readonly layered?: boolean;
}

// The cropped mark's intrinsic size. Both dimensions are passed explicitly: outside Next's bundler (Vitest) a
// static image import is a bare path with no size, and next/image then needs a width.
const MARK_WIDTH = 296;
const MARK_HEIGHT = 303;

/** The chat's loading state: the mark at 48 px with its ring turning, centered. The words are for screen readers. */
export function JarvisLoading({ label = "Loading conversation" }: { readonly label?: string }): ReactElement {
  return (
    <div role="status" data-jarvis-working className="jarvis-row flex min-h-60 items-center justify-center">
      <JarvisMark size={48} layered />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Jarvis's avatar: the app's logo mark alone, with no tile or container behind it (Docs/DESIGN.md → Icons). It
 * always sits next to the name "Jarvis" or in the thread under it, so the image itself is decorative.
 */
export function JarvisMark({ size, className = "", layered = false }: JarvisMarkProps): ReactElement {
  const width = Math.round((size * MARK_WIDTH) / MARK_HEIGHT);
  const box = { width, height: size };
  // The fixed inline size stops a flex parent from stretching or squashing the mark; alignment is the caller's.
  if (!layered) {
    return (
      <Image src={logo} alt="" width={width} height={size} style={box} className={`shrink-0 ${className}`} />
    );
  }
  return (
    <span aria-hidden="true" style={box} className={`relative inline-block shrink-0 ${className}`}>
      <Image
        src={logo}
        alt=""
        width={width}
        height={size}
        style={box}
        className="jarvis-mark-ring absolute inset-0"
      />
      <Image
        src={logo}
        alt=""
        width={width}
        height={size}
        style={box}
        className="jarvis-mark-eye absolute inset-0"
      />
    </span>
  );
}
