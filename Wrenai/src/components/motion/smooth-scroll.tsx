"use client";

import type { LenisOptions } from "lenis";
import { type LenisRef, ReactLenis } from "lenis/react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

// Lenis owns its frame loop. The signed-in app has no scroll-linked GSAP animation to synchronize.
// lerp 0.2: each frame closes 20% of the distance, so the page settles in about a quarter second. The default 0.1
// trails the wheel by half a second, which on a trackpad (already smoothed by the OS) reads as a heavy page.
// allowNestedScroll lets inner scroll areas (tables, the chat log) take the wheel without fighting the page.
const BASE_OPTIONS: LenisOptions = {
  autoRaf: true,
  syncTouch: false,
  lerp: 0.2,
  wheelMultiplier: 1,
  allowNestedScroll: true,
};

/**
 * Page smooth scroll. Lenis stays mounted for every render: swapping the wrapper on hydration (the server can't
 * read the motion preference) would remount the whole app on every load. Under reduced motion only the smoothing
 * turns off, so the wheel scrolls natively.
 */
export function SmoothScroll({ children }: { readonly children: ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const lenisRef = useRef<LenisRef>(null);
  const pathname = usePathname();
  const lastPathname = useRef(pathname);
  const options = useMemo<LenisOptions>(
    () => ({ ...BASE_OPTIONS, smoothWheel: !reducedMotion }),
    [reducedMotion],
  );

  useEffect(() => {
    if (lastPathname.current === pathname) {
      return;
    }
    lastPathname.current = pathname;
    // Next has already placed the window for this navigation (top, or the restored position on back); stop any
    // smooth scroll in flight and adopt that position.
    lenisRef.current?.lenis?.scrollTo(window.scrollY, { immediate: true, force: true });
  }, [pathname]);

  return (
    <ReactLenis root options={options} ref={lenisRef}>
      {children}
    </ReactLenis>
  );
}
