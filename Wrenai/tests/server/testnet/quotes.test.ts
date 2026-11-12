import { sign } from "node:crypto";
import { QuoteRequest, quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ed25519KeyFromSeed, ed25519PublicKey } from "@/server/near/ed25519-key";
import { type TideQuote, validateTideQuote } from "@/server/testnet/provider";

const input = "nep141:usdc.tidepool-sandbox.testnet",
  output = "nep141:usdt.tidepool-sandbox.testnet";
function signedQuote() {
  const now = Date.now(),
    key = ed25519KeyFromSeed(Buffer.alloc(32, 3)),
    deadline = new Date(now + 120000).toISOString();
  const q: TideQuote = {
    correlationId: "testnet-unit",
    timestamp: new Date(now).toISOString(),
    signature: "",
    quoteRequest: {
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: 49,
      originAsset: input,
      destinationAsset: output,
      amount: "1000000",
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      refundTo: "pool.testnet",
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: "pool.testnet",
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline,
    },
    quote: {
      amountIn: "1000000",
      amountOut: "997000",
      minAmountIn: "1000000",
      minAmountOut: "992015",
      amountInFormatted: "1",
      amountOutFormatted: "0.997",
      amountInUsd: "1",
      amountOutUsd: "0.997",
      depositAddress: "deposit.testnet",
      deadline,
      timeEstimate: 10,
    },
  };
  q.signature = base58.encode(sign(null, Buffer.from(quoteHash(q)), key));
  return {
    q,
    now,
    key: ed25519PublicKey(key),
    expected: {
      input,
      output,
      units: "1000000",
      account: "pool.testnet",
      slippage: 50,
      dry: false,
      deadline,
    },
  };
}
describe("Tidepool signed quote boundary", () => {
  it("verifies the actual SDK signature using the configured testnet key", () => {
    const { q, now, key, expected } = signedQuote();
    expect(validateTideQuote(q, expected, now, key).quote.amountOut).toBe("997000");
  });
  it("rejects changed assets, recipient, debit, slippage and signer", () => {
    const { q, now, key, expected } = signedQuote();
    for (const change of [
      { input: "native:near" },
      { output: input },
      { account: "attacker.testnet" },
      { units: "2000000" },
      { slippage: 100 },
    ]) {
      expect(() => validateTideQuote(q, { ...expected, ...change }, now, key)).toThrow();
    }
    expect(() =>
      validateTideQuote(q, expected, now, ed25519PublicKey(ed25519KeyFromSeed(Buffer.alloc(32, 4)))),
    ).toThrow();
  });
  it("binds signed deposit, refund and receive locations independently", () => {
    const { q, now, key, expected } = signedQuote();
    const signer = ed25519KeyFromSeed(Buffer.alloc(32, 3));
    q.quoteRequest.depositType = QuoteRequest.depositType.INTENTS;
    q.quoteRequest.refundType = QuoteRequest.refundType.INTENTS;
    q.quoteRequest.recipientType = QuoteRequest.recipientType.INTENTS;
    q.signature = base58.encode(sign(null, Buffer.from(quoteHash(q)), signer));
    expect(
      validateTideQuote(q, { ...expected, location: "intents", outputLocation: "intents" }, now, key),
    ).toEqual(q);
    expect(() => validateTideQuote(q, expected, now, key)).toThrow();
    expect(() =>
      validateTideQuote(q, { ...expected, location: "intents", outputLocation: "wallet" }, now, key),
    ).toThrow();
    q.quoteRequest.refundType = QuoteRequest.refundType.ORIGIN_CHAIN;
    q.signature = base58.encode(sign(null, Buffer.from(quoteHash(q)), signer));
    expect(() =>
      validateTideQuote(q, { ...expected, location: "intents", outputLocation: "intents" }, now, key),
    ).toThrow();
  });
  it("rejects stale and forged responses and does not accept an unsigned minimum-output change", () => {
    const { q, now, key, expected } = signedQuote();
    expect(() => validateTideQuote(q, expected, now + 15001, key)).toThrow();
    expect(() => validateTideQuote({ ...q, signature: "invalid" }, expected, now, key)).toThrow();
    expect(() =>
      validateTideQuote({ ...q, quote: { ...q.quote, minAmountOut: "1" } }, expected, now, key),
    ).toThrow();
  });
});
