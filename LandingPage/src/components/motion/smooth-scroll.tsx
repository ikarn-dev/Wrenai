"use client";

import type { LenisOptions } from "lenis";
import { type LenisRef, ReactLenis, useLenis } from "lenis/react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef } from "react";
import { gsap, ScrollTrigger } from "./gsap";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

// The landing page's glide (user request, Nov 2026: smoother than the app's snappier 0.2). Lenis 1.3 damps wheel
// scrolling by time, not by frame: each frame moves 1 − e^(−60·lerp·dt) of the way (lenis.mjs → damp), so the
// feel is the same at 60, 120 or 144 Hz. lerp 0.08 gives a time constant of about 0.21 s: a small wheel step
// eases out over roughly 0.6 s instead of stopping dry in 0.25 s, without trailing so far that it feels
// detached. Lenis runs on GSAP's ticker (Docs/tech-stack.md → Lenis), which follows the display's refresh rate,
// so scroll-linked animations read the same position on the same frame. Touch keeps native scrolling, the
// platform's own momentum.

/**
 * Long jumps (anchors, Back to top): a 1.2 s expo ease-out, so the page leaves quickly and settles softly. Passed
 * per call, never as a global `duration`: Lenis prefers duration over lerp whenever both are set, which would
 * restart a fixed easing on every wheel event and make small scrolls stutter.
 */
export const GLIDE = {
  duration: 1.2,
  easing: (t: number): number => Math.min(1, 1.001 - 2 ** (-10 * t)),
} as const;

const BASE_OPTIONS: LenisOptions = {
  autoRaf: false,
  syncTouch: false,
  lerp: 0.08,
  wheelMultiplier: 1,
  allowNestedScroll: true,
  anchors: GLIDE,
};

/** Tells ScrollTrigger about every Lenis scroll. Inside ReactLenis, so it subscribes once the instance exists. */
function ScrollTriggerSync(): null {
  useLenis(ScrollTrigger.update);
  return null;
}

/**
 * Page smooth scroll. Lenis stays mounted for every render: swapping the wrapper on hydration (the server can't
 * read the motion preference) would remount the page. Under reduced motion only the smoothing turns off.
 */
export function SmoothScroll({ children }: { readonly children: ReactNode }): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const lenisRef = useRef<LenisRef>(null);
  const options = useMemo<LenisOptions>(
    () => ({ ...BASE_OPTIONS, smoothWheel: !reducedMotion }),
    [reducedMotion],
  );

  // With autoRaf off, Lenis moves only when this ticker drives it. The instance is created after this effect
  // runs (ReactLenis builds it in its own effect, and again when the options change), so it's read on every
  // tick rather than captured once: a captured, still-missing instance would leave the wheel swallowed and the
  // page unable to scroll.
  useEffect(() => {
    const tick = (time: number): void => lenisRef.current?.lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => gsap.ticker.remove(tick);
  }, []);

  return (
    <ReactLenis root options={options} ref={lenisRef}>
      <ScrollTriggerSync />
      {children}
    </ReactLenis>
  );
}
