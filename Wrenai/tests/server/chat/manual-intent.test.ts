import { describe, expect, it, vi } from "vitest";
import { isManualTradeRequest } from "@/shared/chat-quote";
import { manualAgentBrief } from "@/shared/manual-agent-brief";
import { manualIntentSchema } from "@/shared/manual-trading";

vi.mock("server-only", () => ({}));
describe("immediate trading intent boundaries", () => {
  it.each([
    "Swap 10 USDC to NEAR",
    "Please buy 2 NEAR using USDC",
    "I want to open a BTC long",
    "Close my NEAR long",
    "Quote 0.1 NEAR to USDC",
    "Give me a quote for selling 0.1 NEAR to USDC",
    "Can you show me a fresh quote for buying 2 NEAR using USDC?",
    "I want a quote for 10 USDC to NEAR",
    "What's the quote for selling 0.1 NEAR?",
    "How much USDC do I get for 0.1 NEAR?",
    "What would I receive for 0.1 NEAR to USDC?",
    "yes give me i want to sell",
    "Yes, please sell 0.1 NEAR for USDC",
  ])("recognizes an immediate request: %s", (message) => {
    expect(isManualTradeRequest(message)).toBe(true);
  });
  it.each([
    "Should I buy NEAR?",
    "Analyze BTC long or short",
    "What should I do next?",
    "Buy NEAR every day",
    "Buy the dip when NEAR falls 5%",
    "Open a perps agent",
    "Explain how to swap",
    "Swap code example",
    "Yes, do it",
    "Should I sell 0.1 NEAR for USDC?",
    "Show me a quote for buying NEAR every day",
    "Don't sell my NEAR",
    "Cancel that quote",
    "How much is NEAR worth?",
  ])("never treats analysis, automation or a conversational yes as execution permission: %s", (message) => {
    expect(isManualTradeRequest(message)).toBe(false);
  });
  it("rejects ambiguous or nonpositive sizes and same-token spot orders", () => {
    const spot = {
      kind: "spot",
      inputAssetId: "nep141:wrap.near",
      outputAssetId: "nep141:wrap.near",
      amount: "1",
      balance: "confidential",
      slippageBps: 50,
      maximumFeeBps: 0,
    };
    expect(manualIntentSchema.safeParse(spot).success).toBe(false);
    expect(
      manualIntentSchema.safeParse({ ...spot, outputAssetId: "nep141:usdc.near", amount: "0" }).success,
    ).toBe(false);
    expect(
      manualIntentSchema.safeParse({ ...spot, outputAssetId: "nep141:usdc.near", amount: "all" }).success,
    ).toBe(false);
  });
  it("keeps automate as a new reviewed setup rather than reusing manual authorization", () => {
    const spot = manualIntentSchema.parse({
      kind: "spot",
      inputAssetId: "nep141:wrap.near",
      outputAssetId: "nep141:usdc.near",
      amount: "1",
      balance: "confidential",
      slippageBps: 50,
      maximumFeeBps: 0,
    });
    expect(manualAgentBrief(spot)).toContain("entry condition");
    expect(manualAgentBrief(spot)).toContain("nep141:wrap.near");
  });
});
