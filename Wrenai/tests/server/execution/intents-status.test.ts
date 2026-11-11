import { describe, expect, it, vi } from "vitest";
import { confirmedStatusQuote, intentsStatusSchema } from "@/server/execution/intents-reconciliation";

// Recorded shape of the quote 1Click echoes in /v0/status for a direct native NEAR deposit (Nov 2026): no
// correlationId, and unset routing fields sent as null. verifiedProviderQuote treats both as absent; its
// signature check is covered with signed fixtures in tests/server/funding.

vi.mock("server-only", () => ({}));

// The shape live 1Click returned for a native NEAR deposit still in flight (Nov 2026): amounts are null, not absent.
const pending = {
  quoteResponse: {},
  status: "PENDING_DEPOSIT",
  updatedAt: "2026-11-07T07:12:00.000Z",
  swapDetails: {
    amountIn: null,
    amountOut: null,
    amountInUsd: null,
    amountOutUsd: null,
    depositedAmount: null,
    refundedAmount: null,
    originChainTxHashes: null,
    destinationChainTxHashes: null,
    intentHashes: [],
  },
};

describe("1Click status quote echo", () => {
  const stored = {
    correlationId: "c1",
    timestamp: "2026-11-07T07:11:00.000Z",
    signature: "ed25519:sig",
    quoteRequest: { recipient: "owner.near", virtualChainRecipient: undefined },
    quote: { depositAddress: "a".repeat(64), amountIn: "1" },
  };
  it("accepts a re-serialized echo of the same signed quote and returns the stored copy", () => {
    const echoed = {
      timestamp: "2026-11-07T07:11:00Z",
      signature: "ed25519:sig",
      quoteRequest: { recipient: "owner.near", virtualChainRecipient: null, depositMode: "SIMPLE" },
      quote: { depositAddress: "a".repeat(64), amountIn: "1" },
    };
    expect(confirmedStatusQuote(stored, echoed)).toBe(stored);
  });
  it.each([
    ["signature", { signature: "ed25519:other" }],
    ["timestamp", { timestamp: "2026-11-07T07:12:00.000Z" }],
    ["deposit address", { quote: { depositAddress: "b".repeat(64) } }],
  ])("rejects an echo with a different %s", (_, change) => {
    expect(() => confirmedStatusQuote(stored, { ...stored, ...change })).toThrow(/different signed quote/);
  });
});

describe("1Click status parsing", () => {
  it("reads null amounts on an unfinished deposit as not yet accounted", () => {
    const status = intentsStatusSchema.parse(pending);
    expect(status.swapDetails.amountIn).toBeUndefined();
    expect(status.swapDetails.depositedAmount).toBeUndefined();
    expect(status.swapDetails.originChainTxHashes).toBeUndefined();
  });
  it("still accepts omitted amounts and keeps reported ones", () => {
    const status = intentsStatusSchema.parse({
      ...pending,
      status: "SUCCESS",
      swapDetails: { intentHashes: ["hash"], amountIn: "1000", amountOut: "990", refundedAmount: "0" },
    });
    expect(status.swapDetails).toMatchObject({ amountIn: "1000", amountOut: "990", refundedAmount: "0" });
    expect(status.swapDetails.amountInUsd).toBeUndefined();
  });
  it("still rejects a malformed amount", () => {
    expect(() =>
      intentsStatusSchema.parse({ ...pending, swapDetails: { ...pending.swapDetails, amountIn: "-1" } }),
    ).toThrow();
  });
});
