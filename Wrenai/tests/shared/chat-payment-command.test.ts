import { describe, expect, it } from "vitest";
import { isPaymentRetry, parseChatPayment } from "@/shared/chat-payment-command";
import { chatRoutingIssue, requestedResearchTools } from "@/shared/chat-routing";

describe("Jarvis payment language", () => {
  it.each([
    ["Hey Jarvis, send over .02 NEAR to later.near", "0.02", "near", "later.near", null],
    ["Pay alice.tg 5 USDC from my NEAR wallet", "5", "usdc", "alice.tg", "wallet"],
    ["Transfer USDC 1,250.05 to if.near", "1250.05", "usdc", "if.near", null],
    ["Give bob.near two and a half NEAR", "2.5", "near", "bob.near", null],
    ["Tip @alice.tg with zero point zero two wrapped NEAR", "0.02", "wrapped near", "alice.tg", null],
    [
      "Remit one thousand two hundred and five USDC to treasury.near privately",
      "1205",
      "usdc",
      "treasury.near",
      "private",
    ],
    ["I'd like to make a payment of twenty-five USD Coin to bob.near", "25", "usd coin", "bob.near", null],
    [
      "Forward `0.02` `nep141:wrap.near` to `now.near` using my confidential balance",
      "0.02",
      "nep141:wrap.near",
      "now.near",
      "private",
    ],
    ["Reimburse 1 NEAR to the account treasury on NEAR mainnet", "1", "near", "treasury", null],
    ["Pay out half a NEAR to alice.near", "0.5", "near", "alice.near", null],
    ["Gift 1 EXAMPLE alice.near", "1", "example", "alice.near", null],
    ["Move 4 of my USDT into alice.near", "4", "usdt", "alice.near", null],
    ["Send 1 LINK to alice.near", "1", "link", "alice.near", null],
  ])("keeps the exact details in %s", (message, amount, token, recipient, route) => {
    expect(parseChatPayment(message)).toEqual({ amount, token, recipient, route });
  });

  it.each([
    ["Transfer 5 to alice.near", "Which token"],
    ["Transfer USDC to alice.near", "How much"],
    ["Pay 5 USDC", "Which NEAR account"],
    ["Send 5 NEAR to Alice", "exact account ID"],
    ["Send 5 NEAR to @alice", "exact account ID"],
    ["Send 5 USDC to 0x1111111111111111111111111111111111111111", "exact account ID"],
    ["Move 5 USDC to alice.near on Solana", "NEAR mainnet"],
    ["Send 1 NEAR to alice.near on NEAR testnet", "NEAR mainnet"],
    ["Send 5 USDC to alice.near in 2 hours", "scheduled"],
    ["Pay 2 NEAR to bob.near if the price drops", "conditional"],
    ["Send 5 USDC to alice.near privately from my public wallet", "Choose one payment route"],
    ["Send half my USDC to alice.near", "exact token amount"],
    ["Send 10% of my NEAR to alice.near", "exact token amount"],
    ["Transfer $5 to alice.near", "exact token amount"],
    ["Send 0 NEAR to alice.near", "exact token amount"],
    ["Pay 2 USDC and 1 NEAR to alice.near", "exact token amount"],
    ["Send 1 USDC to alice.near and 2 NEAR to bob.near", "exact token amount"],
  ])("asks for clarification for %s", (message, explanation) => {
    expect(parseChatPayment(message)).toEqual({ issue: expect.stringContaining(explanation) });
  });

  it.each([
    "How do I transfer 5 USDC to alice.near?",
    "Don't pay 1 NEAR to alice.near",
    "Give me the latest NEAR price",
    "Send me five ideas",
    "Send me a summary about USDC",
    "Send a photo to alice.near",
    "Send an email to alice.near",
    "Pay attention to NEAR",
    "Explain what happens if I send 1 NEAR",
  ])("leaves %s outside the payment flow", (message) => {
    expect(parseChatPayment(message)).toBeNull();
    expect(isPaymentRetry(message)).toBe(false);
  });

  it("uses the same recognition in the composer and server", () => {
    expect(isPaymentRetry("Jarvis, could you try to remit it again?")).toBe(true);
    expect(isPaymentRetry("Try again")).toBe(false);
    expect(requestedResearchTools("Tip 5 ARB to alice.near")).toEqual(["private_payments"]);
    expect(chatRoutingIssue("Tip 5 ARB to alice.near", "private_payments")).toBeNull();
    expect(chatRoutingIssue("Tip 5 ARB to alice.near", "perps")).toContain("Private Payments");
  });
});
