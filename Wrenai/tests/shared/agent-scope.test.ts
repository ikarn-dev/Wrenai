import { describe, expect, it, vi } from "vitest";
import { RESEARCH_DEFINITIONS } from "@/server/research/dispatcher";
import { activeAgentToolSchema, isActiveAgentTool, isRemovedExecutablePack } from "@/shared/agent-scope";
import { researchToolSchema } from "@/shared/research";

vi.mock("server-only", () => ({}));
describe("eight-agent capability boundary", () => {
  it("advertises exactly the requested eight tools and no removed function", () => {
    const expected = [
      "private_payments",
      "dca",
      "spot_trader",
      "perps",
      "meme_hunter",
      "whale_tracker",
      "buy_the_dip",
      "sell_the_top",
    ];
    expect(activeAgentToolSchema.options).toEqual(expected);
    expect(RESEARCH_DEFINITIONS.map((definition) => definition.function.name)).toEqual(
      expected.map((tool) => `research_${tool}`),
    );
  });
  it.each([
    "arbitrage",
    "copy_trading",
    "rebalancer",
    "yield_optimizer",
    "lp_manager",
    "lending_margin",
    "triggers",
  ])("keeps %s readable only as historical data", (tool) => {
    expect(researchToolSchema.safeParse(tool).success).toBe(true);
    expect(isActiveAgentTool(tool)).toBe(false);
  });
  it("blocks removed executable packs without blocking the reusable price engine", () => {
    expect(isRemovedExecutablePack("rebalancer")).toBe(true);
    expect(isRemovedExecutablePack("copy_trading")).toBe(true);
    expect(isRemovedExecutablePack("triggers")).toBe(false);
  });
});
