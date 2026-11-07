"use client";

import { createContext, type RefObject, useContext, useEffectEvent } from "react";
import { gsap, ScrollTrigger, useGSAP } from "@/components/motion/gsap";

/**
 * Called each time a scene's loop finishes a pass (after its rest, as the next pass begins). The agents carousel
 * provides it to move to the next agent; elsewhere there is none.
 */
export const SceneCycle = createContext<(() => void) | null>(null);

/**
 * One looping scene animation: `build` fills a paused timeline, which plays only while the scene is on screen.
 * Under reduced motion nothing is built, so the scene shows its finished, still state and never reports a pass.
 * A scene whose parts are drawn later (a React Flow canvas) passes `drawn`: null until they exist, then an ID that
 * changes when they are redrawn, which rebuilds the timeline.
 */
export function useSceneLoop(
  root: RefObject<HTMLElement | null>,
  build: (timeline: gsap.core.Timeline, element: HTMLElement) => void,
  repeatDelay = 2.2,
  drawn: string | null = "static",
): void {
  const onCycle = useContext(SceneCycle);
  // Reads the latest callback without rebuilding the timeline when it changes.
  const finishPass = useEffectEvent(() => onCycle?.());
  useGSAP(
    () => {
      const element = root.current;
      if (!element || drawn === null) {
        return;
      }
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const timeline = gsap.timeline({
          repeat: -1,
          repeatDelay,
          paused: true,
          onRepeat: () => finishPass(),
        });
        build(timeline, element);
        const trigger = ScrollTrigger.create({
          trigger: element,
          start: "top bottom",
          end: "bottom top",
          onToggle: (self) => {
            if (self.isActive) {
              timeline.play();
            } else {
              timeline.pause();
            }
          },
        });
        if (trigger.isActive) {
          timeline.play();
        }
      });
      return () => media.revert();
    },
    { scope: root, dependencies: [drawn], revertOnUpdate: true },
  );
}
