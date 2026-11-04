import { usePathname } from "next/navigation";
import { Tooltip } from "radix-ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNav } from "@/components/shell/mobile-nav";
import { NAV_ITEMS } from "@/components/shell/nav-items";
import { NavigationItems } from "@/components/shell/navigation-items";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));

function renderNavigation(view: "expanded" | "collapsed" | "mobile"): string {
  return renderToStaticMarkup(
    createElement(Tooltip.Provider, null, createElement(NavigationItems, { items: NAV_ITEMS, view })),
  );
}

function links(markup: string): readonly string[] {
  return Array.from(markup.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g), (match) => match[1] ?? "");
}

describe("app navigation", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/portfolio");
  });

  it("keeps the mobile bar focused on available screens with room for touch targets", () => {
    const markup = renderToStaticMarkup(createElement(MobileNav));
    expect(links(markup)).toEqual([
      "/portfolio",
      "/agents",
      "/chat",
      "/activity",
      "/proof",
      "/spot",
      "/perps",
      "/settings",
    ]);
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("min-w-14");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("selects Chat for a saved conversation", () => {
    vi.mocked(usePathname).mockReturnValue("/chat/a-conversation");
    expect(renderNavigation("expanded")).toMatch(
      /<a\b(?=[^>]*href="\/chat")(?=[^>]*aria-current="page")[^>]*>/,
    );
  });

  it("opens the shared Activity screen from the navigation", () => {
    vi.mocked(usePathname).mockReturnValue("/activity");
    expect(renderNavigation("expanded")).toMatch(
      /<a\b(?=[^>]*href="\/activity")(?=[^>]*aria-current="page")[^>]*>/,
    );
  });

  it.each(["expanded", "collapsed", "mobile"] as const)(
    "links the implemented Proof screen in the %s navigation",
    (view) => {
      const markup = renderNavigation(view);
      expect(links(markup)).toEqual([
        "/portfolio",
        "/agents",
        "/chat",
        "/activity",
        "/proof",
        "/spot",
        "/perps",
        "/settings",
      ]);
      expect(markup).not.toContain('aria-disabled="true"');
      expect(markup).not.toContain('aria-label="Proof is not built yet"');
    },
  );

  it.each(["expanded", "collapsed", "mobile"] as const)(
    "announces only the current page in the %s navigation",
    (view) => {
      const markup = renderNavigation(view);
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      expect(markup).toMatch(/<a\b(?=[^>]*href="\/portfolio")(?=[^>]*aria-current="page")[^>]*>/);
    },
  );

  it("keeps Settings selected on a nested settings screen", () => {
    vi.mocked(usePathname).mockReturnValue("/settings/agent-key");
    const markup = renderNavigation("expanded");
    expect(markup).toMatch(/<a\b(?=[^>]*href="\/settings")(?=[^>]*aria-current="page")[^>]*>/);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("does not select a route that only shares a name prefix", () => {
    vi.mocked(usePathname).mockReturnValue("/settings-other");
    expect(renderNavigation("expanded")).not.toContain('aria-current="page"');
  });

  it("names each available link when its visible label is hidden", () => {
    const markup = renderNavigation("collapsed");
    expect(markup).toContain('aria-label="Portfolio"');
    expect(markup).toContain('aria-label="Settings"');
  });
});
