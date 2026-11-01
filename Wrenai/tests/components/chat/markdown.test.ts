import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/chat/markdown";

describe("untrusted chat Markdown", () => {
  it("does not render HTML, executable links, remote images or embedded controls", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        content:
          "<script>alert(1)</script>\n\n<button>Execute</button>\n\n[run](javascript:alert%281%29)\n\n![tracker](https://example.com/track.png)",
      }),
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("track.png");
  });

  it("renders code as text, accessible tables and safe external links", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        content:
          "```html\n<script>example()</script>\n```\n\n| Asset | Risk |\n| --- | --- |\n| NEAR | Variable |\n\n[Reference](https://example.com/docs)",
      }),
    );
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("Copy code");
    expect(markup).toContain("<table");
    expect(markup).toContain("<th class=");
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("data-lenis-prevent");
    expect(markup).toContain("overscroll-x-contain");
    expect(markup).toContain("table-fixed");
    expect(markup).toContain("wrap-anywhere");
  });
});
