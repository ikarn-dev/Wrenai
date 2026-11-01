"use client";

import gsap from "gsap";
import type { LenisOptions } from "lenis";
import { type LenisRef, ReactLenis } from "lenis/react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

// Driven by GSAP's ticker (autoRaf off) so scroll-linked GSAP animations read the same frame.
// Touch keeps native scrolling. Docs/tech-stack.md → Smooth scrolling and animation.
const LENIS_OPTIONS: LenisOptions = { autoRaf: false, syncTouch: false };

function LenisRoot({ children }: { readonly children: ReactNode }) {
  const lenisRef = useRef<LenisRef>(null);
  const pathname = usePathname();
  const lastPathname = useRef(pathname);

  useEffect(() => {
    function tick(timeSeconds: number): void {
      lenisRef.current?.lenis?.raf(timeSeconds * 1000);
    }
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => gsap.ticker.remove(tick);
  }, []);

  useEffect(() => {
    if (lastPathname.current === pathname) {
      return;
    }
    lastPathname.current = pathname;
    // Next has already placed the window for this navigation (top, or the restored position on back);
    // stop any smooth scroll in flight and adopt that position.
    lenisRef.current?.lenis?.scrollTo(window.scrollY, { immediate: true, force: true });
  }, [pathname]);

  return (
    <ReactLenis root options={LENIS_OPTIONS} ref={lenisRef}>
      {children}
    </ReactLenis>
  );
}

export function SmoothScroll({ children }: { readonly children: ReactNode }) {
  return usePrefersReducedMotion() ? children : <LenisRoot>{children}</LenisRoot>;
}
