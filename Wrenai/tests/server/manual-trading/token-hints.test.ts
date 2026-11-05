import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChatQuote } from "@/server/manual-trading/token-hints";

vi.mock("server-only", () => ({}));
const source = vi.hoisted(() => ({ tokens: vi.fn() }));
vi.mock("@/server/research/intents", () => ({ intentTokens: source.tokens }));
const request = {
  requestId: "5637fe91-a6c8-4970-8840-93281a123fde",
  inputToken: "wnear",
  outputToken: "usdc",
  amount: "0.1",
};
beforeEach(() => {
  source.tokens.mockReset().mockResolvedValue({
    tokens: [
      { assetId: "nep141:usdc.near", symbol: "USDC", blockchain: "near", decimals: 6 },
      { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
    ],
  });
});
describe("server-side chat quote resolution", () => {
  it("resolves exact token identities without changing the amount or execution defaults", async () => {
    expect(await resolveChatQuote(request)).toEqual({
      requestId: request.requestId,
      source: "jarvis",
      intent: {
        kind: "spot",
        inputAssetId: "nep141:wrap.near",
        outputAssetId: "nep141:usdc.near",
        amount: "0.1",
        balance: "confidential",
        slippageBps: 50,
        maximumFeeBps: 20,
      },
    });
  });
  it("requires a contract for ambiguous tickers rather than selecting arbitrary funds", async () => {
    source.tokens.mockResolvedValue({
      tokens: [
        { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
        ...["first", "second"].map((name) => ({
          assetId: `nep141:${name}.near`,
          symbol: "USDC",
          blockchain: "near",
          decimals: 6,
        })),
      ],
    });
    await expect(resolveChatQuote(request)).rejects.toMatchObject({ code: "not_ready" });
  });
  it("rejects native NEAR as an output without substituting wNEAR", async () => {
    await expect(resolveChatQuote({ ...request, inputToken: "USDC", outputToken: "NEAR" })).rejects.toThrow(
      "Native NEAR payouts are currently available for USDC swaps from your wallet.",
    );
  });
  it("rejects unknown fields and invalid amounts before provider reads", async () => {
    await expect(resolveChatQuote({ ...request, amount: "0", confirm: true })).rejects.toThrow();
    expect(source.tokens).not.toHaveBeenCalled();
  });
});
