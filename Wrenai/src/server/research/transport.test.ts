import { afterEach, describe, expect, it, vi } from "vitest";
import { drySwapQuote } from "./intents";
import { marketJson } from "./market-http";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());
describe("public research transport", () => {
  it("keeps JSON numeric tokens exact and blocks unbounded provider bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"value":900719925474099312345,"price":1.23e-17}')),
    );
    expect((await marketJson("test", "https://example.com")).value).toEqual({
      value: "900719925474099312345",
      price: "1.23e-17",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(3_000_001))));
    await expect(marketJson("test", "https://example.com")).rejects.toThrow("unavailable");
  });
  it("always requests a dry quote with exact units and rejects mismatched amount currencies", async () => {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/tokens")) {
        return Response.json([
          { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
          { assetId: "nep141:usdc.near", symbol: "USDC", blockchain: "near", decimals: 6 },
        ]);
      }
      expect(JSON.parse(String(options?.body))).toMatchObject({
        dry: true,
        amount: "1000000000000000000000000",
        originAsset: "nep141:wrap.near",
        destinationAsset: "nep141:usdc.near",
      });
      return Response.json({ quote: { amountIn: "1000000000000000000000000", amountOut: "4200000" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await drySwapQuote({ symbols: ["NEAR", "USDC"], amount: "1", amountAsset: "NEAR" });
    expect(result.item.status).toBe("quoted");
    await expect(
      drySwapQuote({ symbols: ["NEAR", "USDC"], amount: "10", amountAsset: "USD" }),
    ).rejects.toThrow("denomination");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
