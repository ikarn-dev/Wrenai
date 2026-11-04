import type { ReactElement } from "react";

// What Wrenai actually runs on (Docs/tech-stack.md, Docs/wrenai-spec.md), shown as plain wordmarks until logo
// files arrive. Real names only: the design rules forbid fake logos, and "Powered by" must be true.
const NAMES = [
  "NEAR Protocol",
  "NEAR AI Cloud",
  "NEAR Intents",
  "1Click",
  "Hyperliquid",
  "RHEA Finance",
  "Meta Pool",
  "LiNEAR",
  "NearBlocks",
] as const;

function NameList({ hidden = false }: { readonly hidden?: boolean }): ReactElement {
  return (
    <ul aria-hidden={hidden ? true : undefined} className="marquee-list">
      {NAMES.map((name) => (
        <li key={name} className="text-marquee font-medium whitespace-nowrap text-fg-muted">
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * A "Powered by" band under the hero: a centered label between two fading rules, then the names on an endless
 * marquee that fades out at both edges. A server component with no client code; the loop is one CSS transform
 * animation (marquee.css), so it runs on the compositor.
 */
export function PoweredBy(): ReactElement {
  return (
    <section aria-labelledby="powered-by-title" className="mx-auto w-full max-w-landing px-gutter py-band">
      <div className="flex items-center justify-center gap-4">
        <span aria-hidden="true" className="fade-rule h-px w-16 sm:w-24" />
        {/* hero-lead (15 → 18 px), the hero subtext's size, under the names' marquee size (20 → 22 px): a 1.22×
            step, so neither reads as a mistake. */}
        <h2 id="powered-by-title" className="text-hero-lead font-medium text-fg-subtle">
          Powered by
        </h2>
        <span aria-hidden="true" className="fade-rule h-px w-16 -scale-x-100 sm:w-24" />
      </div>
      <div className="marquee mt-8">
        <div className="marquee-track">
          <NameList />
          {/* The second copy makes the loop seamless; screen readers get the list once. */}
          <NameList hidden />
        </div>
      </div>
    </section>
  );
}
