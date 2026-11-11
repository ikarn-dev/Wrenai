import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityRow } from "@/components/activity/row";
import type { ActivityEntry } from "@/shared/activity";

const base: ActivityEntry = {
  id: "row",
  source: "wallet",
  category: "wallet",
  title: "NEAR received",
  description: "From friend.near",
  status: "completed",
  occurredAt: 1_793_000_000_000,
  agent: null,
  transactionHash: "H".repeat(44),
  amount: { kind: "token", units: "1", decimals: 24, direction: "in", symbol: "NEAR" },
};
describe("activity timeline rows", () => {
  it("provides exact amounts, UTC dates and public transaction links without nested scrolling", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { item: base }));
    expect(html).toContain("0.000000000000000000000001 NEAR");
    expect(html).toContain(`https://nearblocks.io/txns/${base.transactionHash}`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("UTC");
    expect(html).not.toMatch(/overflow-y|data-lenis-prevent/);
  });
  it("shows an app event on one line without an origin column or a link to its agent", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityRow, {
        item: {
          ...base,
          source: "agents",
          category: "agent",
          title: "Agent deleted",
          description: "Funds returned, history kept",
          status: "deleted",
          agent: { id: "deleted", name: "Old agent", deleted: true },
          transactionHash: null,
          amount: null,
        },
      }),
    );
    expect(html).toContain("Funds returned, history kept");
    expect(html).toContain("truncate");
    expect(html).toContain("Deleted");
    expect(html).not.toContain("Old agent");
    expect(html).not.toContain("href=");
  });
});
