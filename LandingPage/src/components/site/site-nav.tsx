import type { ReactElement } from "react";
import { appHref } from "@/app-url";
import { Brand } from "./brand";

// In-page sections, in page order, the same as the footer's Links (Docs/DESIGN.md → Screens → Landing). Lenis
// scrolls to them smoothly.
const SECTIONS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agents", label: "Agents" },
  { href: "#privacy", label: "Privacy" },
  { href: "#faq", label: "FAQ" },
] as const;

const LINK =
  "inline-flex h-10 items-center rounded-full px-3.5 text-small font-medium text-fg-muted transition-colors duration-300 ease-ios hover:text-fg-strong pointer-coarse:h-11";

/** The hero's top bar: brand on the left, sections in the center (from md), the app on the right. */
export function SiteNav(): ReactElement {
  return (
    <header className="relative z-10 mx-auto grid h-hero-nav w-full max-w-landing grid-cols-[1fr_auto] items-center px-gutter sm:grid-cols-[1fr_auto_1fr]">
      <a href="/" aria-label="Wrenai home" className="justify-self-start rounded-sm">
        <Brand />
      </a>
      {/* From 640 px: below that the brand, four links and Launch app can't share one row at the 12 px floor. */}
      <nav aria-label="Sections" className="hidden sm:block">
        <ul className="flex items-center gap-1">
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <a href={section.href} className={LINK}>
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <a
        href={appHref("/")}
        className="launch-shine inline-flex h-10 items-center justify-self-end rounded-full px-4 text-small font-medium text-fg-strong active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
      >
        Launch app
      </a>
    </header>
  );
}
