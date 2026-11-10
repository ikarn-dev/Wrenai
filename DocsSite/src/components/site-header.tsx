import { ArrowUpRight } from "lucide-react";
import type { ReactElement } from "react";
import { appHref } from "@/app-url";
import { Brand } from "./brand";
import { MobileMenu } from "./mobile-menu";
import { Search } from "./search";

/**
 * The top bar, Mintlify style: the brand on the left, search beside it, the app on the right. Solid and sticky with
 * one hairline under it; no blur (DESIGN.md → Avoid). Open app is the one filled mint action on the page.
 */
export function SiteHeader(): ReactElement {
  return (
    <header className="sticky top-0 z-30 border-b border-line-subtle bg-bg">
      <div className="mx-auto flex h-header max-w-app items-center gap-3 px-gutter">
        <MobileMenu />
        <Brand />
        <div className="ml-auto flex items-center gap-2 md:ml-8">
          <Search />
        </div>
        <a
          href={appHref("/")}
          className="hidden h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-small font-medium text-accent-fg transition-[background-color,scale] duration-300 ease-ios hover:bg-accent-text active:scale-97 motion-reduce:active:scale-100 sm:inline-flex md:ml-auto"
        >
          Open app
          <ArrowUpRight aria-hidden="true" size={14} strokeWidth={2} absoluteStrokeWidth />
        </a>
      </div>
    </header>
  );
}
