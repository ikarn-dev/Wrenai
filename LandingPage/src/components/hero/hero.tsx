import type { ReactElement } from "react";
import { SiteNav } from "@/components/site/site-nav";
import { HeroBackdrop } from "./hero-backdrop";
import { JarvisPrompt } from "./jarvis-prompt";

/**
 * The first screen, edge to edge: a dark surface with the brand bar, the headline and Jarvis's composer over a mint light
 * rising from the bottom. A server component with no client code. Nothing starts hidden, so the headline is the
 * Largest Contentful Paint as soon as the font swaps in (Docs/DESIGN.md → Opacity).
 */
export function Hero(): ReactElement {
  return (
    <section aria-labelledby="hero-title">
      <div className="hero-frame relative flex flex-col">
        <HeroBackdrop />
        <SiteNav />
        {/* One layout at every width; the gaps and sizes are fluid tokens (globals.css → hero-*), so the hero
            shrinks with the screen instead of reflowing. Title → subtext → Jarvis, each gap a step up. */}
        {/* Below md the block centers in the screen's height, so a tall phone doesn't leave the lower half empty. */}
        <div className="flex flex-1 flex-col items-center px-gutter pt-hero-top pb-hero-bottom text-center max-md:justify-center">
          <h1 id="hero-title" className="max-w-4xl text-hero">
            Private AI for your De<span className="text-accent-text">Fi</span>
          </h1>
          <p className="mt-hero-sub max-w-xl text-hero-lead text-fg-subtle">
            Research NEAR markets with Jarvis, then turn a plan into an agent that stays inside your limits.
          </p>
          <div className="mt-hero-gap flex w-full justify-center">
            <JarvisPrompt />
          </div>
        </div>
        {/* Sits on the solid core of the bright floor (mint-50 → mint-100): ink 16+:1 / 15.39:1. */}
        <p className="absolute inset-x-0 bottom-hero-floor px-gutter text-center text-body font-medium text-on-glow">
          Agentic trading, native to NEAR
        </p>
      </div>
    </section>
  );
}
