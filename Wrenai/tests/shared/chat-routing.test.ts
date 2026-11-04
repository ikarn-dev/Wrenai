import { describe, expect, it } from "vitest";
import { type ActiveAgentTool, activeAgentToolSchema } from "@/shared/agent-scope";
import { chatRoutingIssue, needsLiveResearch, requestedResearchTools } from "@/shared/chat-routing";

const requests: Record<ActiveAgentTool, string> = {
  dca: "Check a DCA swap quote for NEAR to USDC",
  spot_trader: "Review a spot buy of NEAR with USDC",
  buy_the_dip: "Buy the dip in NEAR spot",
  sell_the_top: "Sell at my profit target",
  meme_hunter: "Find current NEAR memecoins",
  private_payments: "Check this payment to recipient.near",
  perps: "Should I go long or short on NEAR perps?",
};

describe("research tool routing before inference", () => {
  it.each(activeAgentToolSchema.options)("accepts %s requests and blocks unrelated selections", (tool) => {
    const message = requests[tool];
    expect(requestedResearchTools(message)).toEqual([tool]);
    expect(chatRoutingIssue(message, tool)).toBeNull();
    expect(chatRoutingIssue(message, null)).toBeNull();
    for (const other of activeAgentToolSchema.options.filter((candidate) => candidate !== tool)) {
      expect(chatRoutingIssue(message, other)).not.toBeNull();
    }
  });
  it("explains the reported yield/DCA mismatch without changing the selected tool", () => {
    expect(chatRoutingIssue(requests.perps, "dca")).toContain("Switch to Perps or Auto");
  });
  it("requires Auto for separate research goals, while keeping umbrella comparisons together", () => {
    expect(chatRoutingIssue("Compare NEAR memecoins and analyze NEAR perps", "meme_hunter")).toContain(
      "multiple tools",
    );
    expect(chatRoutingIssue("Analyze NEAR perps with take-profit and stop-loss", "perps")).toBeNull();
    expect(
      chatRoutingIssue("Review a spot buy of NEAR with take-profit and stop-loss", "spot_trader"),
    ).toBeNull();
    expect(chatRoutingIssue("Track whale movements for trader.near", null)).toContain("removed");
    expect(chatRoutingIssue("Watch this wallet", "whale_tracker")).toContain("removed");
    expect(chatRoutingIssue("Find arbitrage", null)).toContain("removed");
    expect(chatRoutingIssue("Create a rebalancer agent", null)).toContain("removed");
    expect(chatRoutingIssue("Research this", "copy_trading")).toContain("removed");
  });
  it("preserves vague follow-ups and greetings, ignoring code, URLs and explicit negations", () => {
    for (const message of [
      "What about the risks?",
      "Use the same amount",
      "Hi",
      "Explain `yield_optimizer` in this output",
    ]) {
      expect(chatRoutingIssue(message, "dca")).toBeNull();
    }
    expect(chatRoutingIssue("Not staking, analyze NEAR perps", "perps")).toBeNull();
    expect(requestedResearchTools("See https://example.org/staking")).toEqual([]);
    expect(chatRoutingIssue("Write a poem", "dca")).toContain("Choose Auto");
  });
  it("requires evidence for current research, not definitions or an ordinary follow-up", () => {
    expect(needsLiveResearch(requests.meme_hunter)).toBe(true);
    expect(needsLiveResearch("What is arbitrage?")).toBe(false);
    expect(needsLiveResearch("Explain the risks")).toBe(false);
    expect(needsLiveResearch("What should I do now?", "perps")).toBe(true);
  });
});
