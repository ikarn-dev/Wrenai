import type { ReactElement } from "react";
import { appHref } from "@/app-url";
import { Brand } from "./brand";

// In-page sections (Docs/DESIGN.md → Screens → Landing). Lenis scrolls to them smoothly.
const SECTIONS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#privacy", label: "Privacy" },
  { href: "#guard", label: "Guard" },
  { href: "#jarvis", label: "Jarvis" },
] as const;

const LINK =
  "inline-flex h-10 items-center rounded-full px-3.5 text-small font-medium text-fg-muted transition-colors duration-300 ease-ios hover:text-fg-strong pointer-coarse:h-11";

/** The hero's top bar: brand on the left, sections in the center (from md), the app on the right. */
export function SiteNav(): ReactElement {
  return (
    <header className="relative z-10 mx-auto grid h-20 w-full max-w-landing grid-cols-[1fr_auto] items-center px-gutter md:grid-cols-[1fr_auto_1fr]">
      <a href="/" aria-label="Wrenai home" className="justify-self-start rounded-sm">
        <Brand />
      </a>
      <nav aria-label="Sections" className="hidden md:block">
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
      <a href={appHref("/")} className={`${LINK} justify-self-end text-fg-strong`}>
        Launch app
      </a>
    </header>
  );
}
