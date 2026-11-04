import type { ReactElement } from "react";

/** The hero's light: glow and vertical rules. Decoration only, never interactive or read aloud. */
export function HeroBackdrop(): ReactElement {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      {/* The light sinks a little as the hero scrolls away (ScrollReveals → data-parallax), so it reads as depth. */}
      <div data-parallax="120" className="absolute inset-0">
        <div className="hero-glow absolute inset-0 motion-safe:animate-glow-breathe" />
      </div>
      <div className="hero-columns absolute inset-0" />
    </div>
  );
}
