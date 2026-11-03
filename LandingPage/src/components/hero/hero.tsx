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
        <div className="flex flex-1 flex-col items-center px-gutter pt-16 pb-28 text-center md:pt-24">
          <h1 id="hero-title" className="max-w-4xl text-display-xl">
            Private AI for your De<span className="text-accent-text">Fi</span>
          </h1>
          <p className="mt-5 max-w-xl text-lead text-fg-muted">
            Research NEAR markets with Jarvis, then turn a plan into an agent that stays inside your limits.
          </p>
          <div className="mt-12 flex w-full justify-center md:mt-14">
            <JarvisPrompt />
          </div>
        </div>
        {/* Sits on the solid core of the bright floor (mint-50 → mint-100): ink 16+:1 / 15.39:1. */}
        <p className="absolute inset-x-0 bottom-8 px-gutter text-center text-small font-medium text-ink">
          Agentic trading, native to NEAR
        </p>
      </div>
    </section>
  );
}
