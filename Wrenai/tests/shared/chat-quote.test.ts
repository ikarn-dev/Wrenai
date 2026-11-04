import { describe, expect, it, vi } from "vitest";
import { storedReplySchema } from "@/server/chat/queries";
import { chatReplySchema } from "@/shared/chat";
import { isManualTradeRequest } from "@/shared/chat-quote";

vi.mock("server-only", () => ({}));
describe("routing trade requests to the verified extraction", () => {
  it.each([
    "quote 0.1 near to usdc",
    "Sell 0.1 near for usdc",
    "Please show me a quote for selling 0.1 near to usdc",
    "How much usdc do I get for 0.1 near?",
    "Buy NEAR using 10 USDC",
    "yes give me i want to sell",
    "sell it",
  ])("sends explicit quote and trade requests to the trade parser: %s", (message) => {
    expect(isManualTradeRequest(message)).toBe(true);
  });
  it.each([
    "Should I sell 0.1 NEAR for USDC?",
    "Don't sell 0.1 NEAR for USDC",
    "quote 0.1 NEAR to USDC when NEAR drops",
    "Analyze NEAR",
    "Set up an agent that buys NEAR every week",
  ])("leaves advice, refusals, conditions and automation to research: %s", (message) => {
    expect(isManualTradeRequest(message)).toBe(false);
  });
  it("still reads previews saved before every quote reply was verified", () => {
    const reply = {
      content: "Review your quote below.",
      receipt: null,
      context: null,
      historyTrimmed: false,
      manual: { text: "Review your quote below.", tradeIds: [] },
    };
    expect(storedReplySchema.safeParse({ reply, attestation: null }).success).toBe(true);
    const { manual: _manual, ...ordinaryAnswer } = reply;
    expect(chatReplySchema.safeParse(ordinaryAnswer).success).toBe(false);
  });
});
