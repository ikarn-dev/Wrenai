"use client";

import type { LenisOptions } from "lenis";
import { type LenisRef, ReactLenis, useLenis } from "lenis/react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef } from "react";
import { gsap, ScrollTrigger } from "./gsap";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

// The app's tuned feel (Wrenai/src/components/motion/smooth-scroll.tsx). lerp 0.2: each frame closes 20% of the
// distance, so the page settles in about a quarter second; the default 0.1 trails the wheel and feels heavy on a
// trackpad the OS already smooths. Lenis runs on GSAP's ticker (Docs/tech-stack.md → Lenis), so scroll-linked
// animations read the same position on the same frame. Touch keeps native scrolling, and anchors scroll smoothly.
const BASE_OPTIONS: LenisOptions = {
  autoRaf: false,
  syncTouch: false,
  lerp: 0.2,
  wheelMultiplier: 1,
  allowNestedScroll: true,
  anchors: true,
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
