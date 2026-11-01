import { describe, expect, it } from "vitest";
import { chatRoutingIssue, needsLiveResearch, requestedResearchTools } from "@/shared/chat-routing";
import { type ResearchTool, researchToolSchema } from "@/shared/research";

const requests: Record<ResearchTool, string> = {
  rebalancer: "Rebalance my portfolio allocations",
  triggers: "Check a DCA swap quote for NEAR to USDC",
  copy_trading: "Analyze copy trading for trader.near",
  yield_optimizer:
    "Compare current NEAR yield opportunities using live data, including costs and withdrawal requirements.",
  meme_hunter: "Find current NEAR memecoins",
  private_payments: "Check this payment to recipient.near",
  lp_manager: "Analyze current liquidity pools",
  lending_margin: "Compare current borrowing rates",
  perps: "Should I go long or short on NEAR perps?",
  arbitrage: "Find arbitrage price gaps",
};

describe("research tool routing before inference", () => {
  it.each(researchToolSchema.options)("accepts %s requests and blocks unrelated selections", (tool) => {
    const message = requests[tool];
    expect(requestedResearchTools(message)).toEqual([tool]);
    expect(chatRoutingIssue(message, tool)).toBeNull();
    expect(chatRoutingIssue(message, null)).toBeNull();
    for (const other of researchToolSchema.options.filter((candidate) => candidate !== tool)) {
      expect(chatRoutingIssue(message, other)).not.toBeNull();
    }
  });
  it("explains the reported yield/DCA mismatch without changing the selected tool", () => {
    expect(chatRoutingIssue(requests.yield_optimizer, "triggers")).toContain(
      "Switch to Yield Optimizer or Auto",
    );
  });
  it("requires Auto for separate research goals, while keeping umbrella comparisons together", () => {
    expect(chatRoutingIssue("Find arbitrage and compare staking yields", "arbitrage")).toContain(
      "multiple tools",
    );
    expect(
      chatRoutingIssue(
        "Compare yield opportunities across lending, staking and liquidity pools",
        "yield_optimizer",
      ),
    ).toBeNull();
    expect(chatRoutingIssue("Find spot/perp arbitrage and funding rate gaps", "arbitrage")).toBeNull();
    expect(chatRoutingIssue("Compare lending APRs", "lending_margin")).toBeNull();
    expect(chatRoutingIssue("Compare LP yields", "lp_manager")).toBeNull();
  });
  it("preserves vague follow-ups and greetings, ignoring code, URLs and explicit negations", () => {
    for (const message of [
      "What about the risks?",
      "Use the same amount",
      "Hi",
      "Explain `yield_optimizer` in this output",
    ]) {
      expect(chatRoutingIssue(message, "triggers")).toBeNull();
    }
    expect(chatRoutingIssue("Not staking, analyze NEAR perps", "perps")).toBeNull();
    expect(requestedResearchTools("See https://example.org/staking")).toEqual([]);
    expect(chatRoutingIssue("Write a poem", "triggers")).toContain("Choose Auto");
  });
  it("requires evidence for current research, not definitions or an ordinary follow-up", () => {
    expect(needsLiveResearch(requests.yield_optimizer)).toBe(true);
    expect(needsLiveResearch("What is arbitrage?")).toBe(false);
    expect(needsLiveResearch("Explain the risks")).toBe(false);
    expect(needsLiveResearch("What should I do now?", "perps")).toBe(true);
  });
});
