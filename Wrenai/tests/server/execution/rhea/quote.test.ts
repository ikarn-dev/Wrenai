import { cashAsset, memeAsset } from "@tests/server/squint/fixtures";
import { blockHash, poolId } from "@tests/server/squint/near-profile-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rheaQuoteSchema } from "@/server/execution/rhea/contracts";
import { quoteRhea, rheaTradeQuote } from "@/server/execution/rhea/quote";

vi.mock("server-only", () => ({}));
vi.mock("@/server/engine/instruction-price", () => ({
  assetUsdPrice: async () => ({ n: 1n, d: 3n, observedAt: Date.now() }),
}));
const io = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock("@/server/engine/meme-price", () => ({ memeDclQuote: io.quote }));
vi.mock("@/server/near/rpc", () => ({
  finalBlockTime: async () => Date.now(),
  callViewFunction: async () => ({
    blockHash,
    value: {
      pool_id: poolId,
      token_x: memeAsset.contractAddress,
      token_y: cashAsset.contractAddress,
      state: "Running",
      total_liquidity: "1",
      tax: null,
      whitelist: null,
    },
  }),
}));
beforeEach(() => {
  io.quote.mockReset().mockResolvedValue(10n ** 24n);
});
describe("native quote money rounding and historical envelopes", () => {
  it("rounds independently priced cash proceeds down while risk valuation rounds up", async () => {
    const quote = await quoteRhea(memeAsset, cashAsset, "2000000000000000000", 50, poolId);
    expect(quote.inputMicroUsd).toBe("333334");
    expect(quote.outputMicroUsd).toBe("333333");
    expect(rheaTradeQuote(quote, "a".repeat(64)).outputMicroUsd).toBe("333333");
  });
  it("never assigns the spending-token value to an unpriced meme output", async () => {
    const quote = await quoteRhea(cashAsset, memeAsset, "1000000000000000000000000", 50, poolId);
    expect(quote.inputMicroUsd).toBe("333334");
    expect(rheaTradeQuote(quote, "a".repeat(64)).outputMicroUsd).toBeNull();
  });
  it("keeps old prepared quotes readable without inventing a proceeds valuation", async () => {
    const quote = await quoteRhea(memeAsset, cashAsset, "2000000000000000000", 50, poolId);
    const { outputMicroUsd: _proceeds, ...historical } = quote;
    expect(rheaTradeQuote(rheaQuoteSchema.parse(historical), "a".repeat(64)).outputMicroUsd).toBeNull();
  });
});
