import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import fixture from "@tests/server/execution/oneclick-quote.fixture.json";
import { describe, expect, it, vi } from "vitest";
import { quoteMicroUsd, verifiedDryQuote } from "@/server/execution/oneclick-quote";

vi.mock("server-only", () => ({}));
function request(): QuoteRequest {
  return {
    ...fixture.request,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    depositType: QuoteRequest.depositType.CONFIDENTIAL_INTENTS,
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
    refundType: QuoteRequest.refundType.CONFIDENTIAL_INTENTS,
  };
}
describe("real signed 1Click quote boundary", () => {
  it("verifies a captured public sample with the official SDK and preserves its disclosed partner fee", () => {
    const quote = verifiedDryQuote(
      fixture.response,
      request(),
      "confidential",
      Date.parse(fixture.response.timestamp) + 500,
      51,
    );
    expect(quote.appFeeBps).toBe(20);
    expect(quote.inputUnits).toBe("10000000");
    expect(quote.recipient).toBe("intents.near");
    expect(quote.refundTo).toBe("intents.near");
    expect(quote.inputMicroUsd).toBe("9994980");
    expect(quote.outputMicroUsd).toBe("9990708");
  });
  it("rejects altered output, recipient, expiry and slippage instead of trusting unsigned input", () => {
    const now = Date.parse(fixture.response.timestamp) + 500;
    expect(() =>
      verifiedDryQuote(
        { ...fixture.response, quote: { ...fixture.response.quote, amountOut: "9999999999999999999999999" } },
        request(),
        "confidential",
        now,
        51,
      ),
    ).toThrow();
    expect(() =>
      verifiedDryQuote(
        {
          ...fixture.response,
          quoteRequest: { ...fixture.response.quoteRequest, recipient: "different.near" },
        },
        request(),
        "confidential",
        now,
        51,
      ),
    ).toThrow();
    expect(() => verifiedDryQuote(fixture.response, request(), "confidential", now + 20_000, 51)).toThrow();
    expect(() => verifiedDryQuote(fixture.response, request(), "confidential", now, 1)).toThrow();
  });
  it("rounds debit values up and output values down without floating point", () => {
    expect(quoteMicroUsd("0.0000000001", true)).toBe(1n);
    expect(quoteMicroUsd("0.0000000001", false)).toBe(0n);
    expect(quoteMicroUsd("1000000000000000.123456789", true)).toBe(1000000000000000123457n);
    expect(() => quoteMicroUsd("1e2", true)).toThrow();
  });
});
