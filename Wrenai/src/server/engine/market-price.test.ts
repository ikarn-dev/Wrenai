import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshMarketPrice } from "./market-price";

vi.mock("server-only", () => ({}));
const now = 1_800_000_000_000;
const request = vi.fn();
function book(): {
  bids: [string, string, number][];
  asks: [string, string, number][];
  sequence: number;
  time: string;
  auction_mode: boolean;
} {
  return {
    bids: [["2.000001", "1", 2]],
    asks: [["2.000003", "1", 1]],
    sequence: 123,
    time: new Date(now - 500).toISOString(),
    auction_mode: false,
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  request.mockReset().mockResolvedValue(Response.json(book()));
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("fresh timestamped market-book references", () => {
  it("reads a fixed USD market without caching and preserves exact midpoint units", async () => {
    expect(await freshMarketPrice("NEAR")).toMatchObject({
      symbol: "NEAR",
      priceMicroUsd: 2_000_002n,
      marketAt: now - 500,
    });
    expect(request.mock.calls[0]).toMatchObject([
      "https://api.exchange.coinbase.com/products/NEAR-USD/book?level=1",
      { cache: "no-store", redirect: "error" },
    ]);
  });
  it("rejects stale/future, empty, crossed, wide or auction books", async () => {
    for (const invalid of [
      { ...book(), time: new Date(now - 5000).toISOString() },
      { ...book(), time: new Date(now + 1001).toISOString() },
      { ...book(), bids: [] },
      { ...book(), bids: [["3", "1", 1]] },
      { ...book(), asks: [["4", "1", 1]] },
      { ...book(), auction_mode: true },
    ]) {
      request.mockResolvedValueOnce(Response.json(invalid));
      await expect(freshMarketPrice("NEAR")).rejects.toThrow();
    }
  });
  it("does not treat a stablecoin or an unavailable response as a live underlying market", async () => {
    await expect(freshMarketPrice("USDC")).rejects.toMatchObject({ code: "not_ready" });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(freshMarketPrice("BTC")).rejects.toThrow();
  });
});
