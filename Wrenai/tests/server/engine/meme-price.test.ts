import { cashAsset, memeAsset } from "@tests/server/squint/fixtures";
import { blockHash, poolId, profileViewFixture } from "@tests/server/squint/near-profile-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memeMarketPrice } from "@/server/engine/meme-price";

const io = vi.hoisted(() => ({ view: vi.fn(), usd: vi.fn(), pair: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/near/rpc", () => ({ callViewFunction: io.view }));
vi.mock("@/server/engine/instruction-price", () => ({ assetUsdPrice: io.usd, instructionPrice: io.pair }));
beforeEach(() => {
  vi.resetAllMocks();
  io.usd.mockImplementation(async () => ({ n: 2n, d: 1n, observedAt: Date.now() }));
  io.pair.mockImplementation(async () => ({ n: 3n, d: 1n, observedAt: Date.now() }));
  io.view.mockImplementation(async (_contract: string, method: string) => ({
    value:
      method === "get_pool"
        ? profileViewFixture(method, Date.now())
        : { amount: "1000000000000000000000000" },
    blockHash,
    blockHeight: 123,
  }));
});
describe("exact-contract independent meme price", () => {
  it("prices through the actual token pool and verified NEAR feed rather than a ticker alias", async () => {
    const price = await memeMarketPrice(memeAsset, cashAsset, poolId, "usd");
    expect(price.n).toBe(2n * price.d);
    expect(io.usd).toHaveBeenCalledWith("nep141:wrap.near");
    expect(io.view).toHaveBeenCalledWith(
      "dclv2.ref-labs.near",
      "quote",
      {
        pool_ids: [poolId],
        input_token: "fixture.nearlytrade.near",
        output_token: "wrap.near",
        input_amount: "1000000000000000000",
      },
      undefined,
      blockHash,
    );
  });
  it("preserves one-yocto values and does not relabel quote-token prices as USD", async () => {
    io.view.mockImplementation(async (_contract: string, method: string) => ({
      value: method === "get_pool" ? profileViewFixture(method, Date.now()) : { amount: "1" },
      blockHash,
      blockHeight: 123,
    }));
    const price = await memeMarketPrice(memeAsset, cashAsset, poolId, "quote_token");
    expect(price.n).toBe(1n);
    expect(price.d).toBe(10n ** 24n);
    expect(io.usd).not.toHaveBeenCalled();
    const other = { ...cashAsset, assetId: "nep141:quote.near", contractAddress: "quote.near" };
    const pair = await memeMarketPrice(memeAsset, other, poolId, "quote_token");
    expect(pair.n).toBe(3n);
    expect(pair.d).toBe(10n ** 24n);
    expect(io.pair).toHaveBeenCalledWith(cashAsset, other, 10n ** 24n, false, "quote_token");
  });
  it("rejects an unrelated pool or zero executable reference", async () => {
    io.view.mockResolvedValue({
      value: {
        pool_id: poolId,
        token_x: "other.near",
        token_y: "wrap.near",
        state: "Running",
        total_x: "1",
        total_y: "1",
        total_liquidity: "1",
        whitelist: null,
        tax: null,
      },
      blockHash,
    });
    await expect(memeMarketPrice(memeAsset, cashAsset, poolId, "usd")).rejects.toMatchObject({
      code: "not_ready",
    });
    io.view.mockImplementation(async (_contract: string, method: string) => ({
      value: method === "get_pool" ? profileViewFixture(method, Date.now()) : { amount: "0" },
      blockHash,
    }));
    await expect(memeMarketPrice(memeAsset, cashAsset, poolId, "usd")).rejects.toThrow();
  });
});
