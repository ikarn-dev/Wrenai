"use client";

import { gsap, ScrollTrigger, useGSAP } from "./gsap";

// One long, soft settle (expo out) for everything, so the page moves with one voice. Distances stay small: the
// point is that content arrives, not that it travels. Transform and opacity only, on the compositor.
const EASE = "expo.out";
const DURATION = 1.4;

/**
 * Scroll reveals for the server-rendered sections, driven by data attributes so the sections ship no client
 * code of their own:
 * - `data-reveal="rise"`: fades in while rising 24 px (titles).
 * - `data-reveal="fade"`: fades in only, a beat later (subtext, labels, the marquee).
 * - `data-reveal="stagger"`: its children rise 40 px from 98% scale in turn (card grids).
 * - `data-parallax="<px>"`: drifts by that many pixels as its section scrolls past (decoration only).
 * `data-reveal-delay` adds seconds. Each plays once, when its top passes 88% of the screen. Anything already on
 * screen at load is left alone, so nothing visible blinks out, and the hero is never hidden (it's the LCP).
 * Under reduced motion nothing animates.
 */
export function ScrollReveals(): null {
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const fold = window.innerHeight * 0.88;
      const below = (node: Element): boolean => node.getBoundingClientRect().top > fold;
      const reveal = (node: Element, from: gsap.TweenVars, to: gsap.TweenVars): void => {
        if (!below(node)) {
          return;
        }
        const delay = Number(node.getAttribute("data-reveal-delay") ?? 0);
        gsap.fromTo(node, from, {
          ...to,
          delay,
          duration: DURATION,
          ease: EASE,
          clearProps: "transform,opacity",
          scrollTrigger: { trigger: node, start: "top 88%", once: true },
        });
      };

      for (const node of gsap.utils.toArray<HTMLElement>('[data-reveal="rise"]')) {
        reveal(node, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0 });
      }
      for (const node of gsap.utils.toArray<HTMLElement>('[data-reveal="fade"]')) {
        reveal(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.6, ease: "power2.out" });
      }
      for (const group of gsap.utils.toArray<HTMLElement>('[data-reveal="stagger"]')) {
        const items = Array.from(group.children).filter(below);
        if (items.length === 0) {
          continue;
        }
        gsap.fromTo(
          items,
          { autoAlpha: 0, y: 40, scale: 0.98, transformOrigin: "50% 100%" },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: DURATION,
            ease: EASE,
            stagger: 0.09,
            clearProps: "transform,opacity",
            scrollTrigger: { trigger: group, start: "top 88%", once: true },
          },
        );
      }
      for (const node of gsap.utils.toArray<HTMLElement>("[data-parallax]")) {
        const distance = Number(node.getAttribute("data-parallax") ?? 0);
        gsap.to(node, {
          y: distance,
          ease: "none",
          // scrub: true follows the scroll position exactly: Lenis already smooths it, so a scrub delay on top
          // would make the light lag behind the page.
          scrollTrigger: {
            trigger: node.parentElement ?? node,
            start: "top top",
            end: "bottom top",
            scrub: true,
          },
        });
      }
    });
    // Web fonts change line breaks and heights; measure the trigger positions again once they're in.
    void document.fonts.ready.then(() => ScrollTrigger.refresh());
    return () => media.revert();
  });

  return null;
}
