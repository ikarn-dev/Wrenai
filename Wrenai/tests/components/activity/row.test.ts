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
  it("retains deleted agent names without linking to a removed screen", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityRow, {
        item: {
          ...base,
          source: "agents",
          agent: { id: "deleted", name: "Old agent", deleted: true },
          transactionHash: null,
        },
      }),
    );
    expect(html).toContain("Old agent");
    expect(html).toContain("Deleted agent");
    expect(html).not.toContain("href=");
  });
});
