"use client";

import type { LenisOptions } from "lenis";
import { ReactLenis } from "lenis/react";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

// The app's tuned feel (Wrenai/src/components/motion/smooth-scroll.tsx). lerp 0.2: each frame closes 20% of the
// distance, so the page settles in about a quarter second; the default 0.1 trails the wheel by half a second and
// feels heavy on a trackpad the OS already smooths. Lenis runs its own frame loop: nothing on this page is tied
// to scroll position, so there is no GSAP ticker to share. Touch keeps native scrolling (syncTouch off), and
// anchors scroll smoothly to in-page sections.
const BASE_OPTIONS: LenisOptions = {
  autoRaf: true,
  syncTouch: false,
  lerp: 0.2,
  wheelMultiplier: 1,
  allowNestedScroll: true,
  anchors: true,
};

/**
 * Page smooth scroll. Lenis stays mounted for every render: swapping the wrapper on hydration (the server can't
 * read the motion preference) would remount the page. Under reduced motion only the smoothing turns off.
 */
export function SmoothScroll({ children }: { readonly children: ReactNode }): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const options = useMemo<LenisOptions>(
    () => ({ ...BASE_OPTIONS, smoothWheel: !reducedMotion }),
    [reducedMotion],
  );
  return (
    <ReactLenis root options={options}>
      {children}
    </ReactLenis>
  );
}
