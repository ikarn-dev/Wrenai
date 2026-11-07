"use client";

import { useLenis } from "lenis/react";
import { ArrowUp } from "lucide-react";
import { type ReactElement, useRef } from "react";
import { GLIDE } from "@/components/motion/smooth-scroll";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";

/**
 * Back to top: a round lit-edge button (launch-shine, like Launch app) fixed bottom-right. It shows once the
 * hero has scrolled away and hides back at the top. Visibility is set on the wrapper from Lenis's scroll event,
 * so scrolling never re-renders React; while hidden it is inert, so it can't take focus. Lenis glides it to the
 * top; reduced motion jumps.
 */
export function ScrollToTop(): ReactElement {
  // The wrapper owns position and the show/hide motion; the button keeps launch-shine's own transitions, so the
  // two utilities never compete for one `transition`.
  const wrapper = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const lenis = useLenis(({ scroll }) => {
    const element = wrapper.current;
    if (!element) {
      return;
    }
    const shown = scroll > window.innerHeight * 0.9;
    if (shown !== element.hasAttribute("data-shown")) {
      element.toggleAttribute("data-shown", shown);
      element.inert = !shown;
    }
  });

  return (
    <div ref={wrapper} inert className="scroll-top">
      <button
        type="button"
        aria-label="Back to top"
        title="Back to top"
        onClick={() => lenis?.scrollTo(0, { ...GLIDE, immediate: reducedMotion })}
        className="launch-shine grid size-11 cursor-pointer place-items-center rounded-full text-fg-strong active:scale-95 motion-reduce:active:scale-100"
      >
        <ArrowUp size={18} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
      </button>
    </div>
  );
}
