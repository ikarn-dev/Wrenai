import { describe, expect, it, vi } from "vitest";
import { storedReplySchema } from "@/server/chat/queries";
import { chatReplySchema } from "@/shared/chat";
import { isManualTradeRequest, parseWalletBalanceQuote } from "@/shared/chat-quote";
import { tradeSizeSchema, tradeSizeUnits } from "@/shared/trade-size";

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
    "I'd like to convert the rest of my USDC in my wallet to NEAR",
    "What would half of my wallet USDC get me in NEAR?",
    "Can I trade one and a half USDC for NEAR?",
  ])("sends explicit quote and trade requests to the trade parser: %s", (message) => {
    expect(isManualTradeRequest(message)).toBe(true);
  });
  it.each([
    "Should I sell 0.1 NEAR for USDC?",
    "Don't sell 0.1 NEAR for USDC",
    "quote 0.1 NEAR to USDC when NEAR drops",
    "Analyze NEAR",
    "Set up an agent that buys NEAR every week",
    "Use Python to format this chart",
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

describe("balance-sized wallet swaps", () => {
  it.each([
    ["swap all usdc to near", 396272n],
    ["swap all usdc in my wallet to near", 396272n],
    ["Sell all USDC for native NEAR from my connected NEAR wallet.", 396272n],
    ["Please exchange half of my USDC from my wallet for NEAR", 198136n],
    ["Convert 12.5% of USDC in the wallet into NEAR", 49534n],
  ])("resolves %s against exact available units", (message, expected) => {
    const quote = parseWalletBalanceQuote(message);
    expect(quote?.inputToken.toLowerCase()).toBe("usdc");
    expect(quote && tradeSizeUnits(quote.amount, 6, 396272n)).toBe(expected);
  });
  it("rounds shares down, preserves amounts to keep and leaves conflicting requests to extraction", () => {
    expect(tradeSizeUnits({ kind: "fraction", numerator: "1", denominator: "3" }, 6, 10n)).toBe(3n);
    expect(tradeSizeUnits({ kind: "leave", amount: "0.1" }, 6, 396272n)).toBe(296272n);
    expect(parseWalletBalanceQuote("Swap 150% of USDC in my wallet to NEAR")).toBeNull();
    expect(tradeSizeSchema.safeParse({ kind: "fraction", numerator: "half", denominator: "0" }).success).toBe(
      false,
    );
  });
  it.each([
    "Swap all USDC to wNEAR",
    "Swap all USDC to NEAR from my private balance",
    "Swap all USDC on Solana to NEAR",
    "Swap all other-usdc.near to NEAR",
    "Swap all USDC to NEAR when the price drops",
  ])("keeps the funding source and tokens explicit: %s", (message) => {
    expect(parseWalletBalanceQuote(message)).toBeNull();
  });
});
