import Image from "next/image";
import type { ReactElement } from "react";
import logo from "../../../public/assets/nobg_logo.png";

interface JarvisMarkProps {
  readonly size: number;
  readonly className?: string;
}

/**
 * Jarvis's avatar: the app's logo mark alone, with no tile or container behind it (Docs/DESIGN.md → Icons). It
 * always sits next to the name "Jarvis" or in the thread under it, so the image itself is decorative.
 */
// The cropped mark's intrinsic size. Both dimensions are passed explicitly: outside Next's bundler (Vitest) a
// static image import is a bare path with no size, and next/image then needs a width.
const MARK_WIDTH = 296;
const MARK_HEIGHT = 303;

export function JarvisMark({ size, className = "" }: JarvisMarkProps): ReactElement {
  const width = Math.round((size * MARK_WIDTH) / MARK_HEIGHT);
  return <Image src={logo} alt="" width={width} height={size} className={`shrink-0 ${className}`} />;
}
