import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import { marketJson } from "@/server/research/market-http";
import { WALLET_SWAP_USDC } from "@/shared/wallet-swap";

vi.mock("server-only", () => ({}));
vi.mock("@/server/near/rpc", () => ({ callViewFunction: vi.fn(), viewNearBudgetBalance: vi.fn() }));
vi.mock("@/server/research/market-http", () => ({ marketJson: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FASTNEAR_API_KEY", undefined);
  vi.mocked(viewNearBudgetBalance).mockResolvedValue({
    balance: 10n ** 24n,
    spendable: 9n * 10n ** 23n,
    blockHeight: 5,
  });
  vi.mocked(callViewFunction).mockImplementation(async (contract, method) => ({
    blockHeight: 5,
    value:
      method === "ft_metadata"
        ? { symbol: "SAME", decimals: 24 }
        : contract === "zero.near" || contract === "wrap.near" || `nep141:${contract}` === WALLET_SWAP_USDC
          ? "0"
          : "1000000000000000000000001",
  }));
  vi.mocked(marketJson).mockResolvedValue({
    capturedAt: Date.now(),
    value: {
      account_id: "owner.near",
      tokens: [
        { contract_id: "unlisted.near", balance: "1" },
        { contract_id: "different.near", balance: "1" },
        { contract_id: "unlisted.near", balance: "1" },
        { contract_id: "zero.near", balance: "0" },
      ],
    },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("held NEAR wallet tokens", () => {
  it("lists arbitrary held FTs with exact identities/decimals and final RPC units rather than indexer amounts", async () => {
    const result = await walletTokenHoldings("owner.near");
    expect(result.tokens.map((token) => token.assetId)).toEqual([
      "native:near",
      "nep141:unlisted.near",
      "nep141:different.near",
    ]);
    expect(result.tokens[1]).toMatchObject({
      decimals: 24,
      symbol: "SAME",
      balanceUnits: "1000000000000000000000001",
    });
    expect(callViewFunction).toHaveBeenCalledWith(
      "zero.near",
      "ft_balance_of",
      { account_id: "owner.near" },
      expect.any(AbortSignal),
    );
    expect(callViewFunction).not.toHaveBeenCalledWith(
      "zero.near",
      "ft_metadata",
      expect.anything(),
      expect.anything(),
    );
    expect(result.tokens[0]?.spendableUnits).toBe("900000000000000000000000");
  });
  it("verifies contracts beyond the old cap, including an indexed zero and unfamiliar metadata", async () => {
    const assets = Array.from({ length: 105 }, (_, index) => ({
      contract_id: `token-${index}.near`,
      balance: "0",
    }));
    vi.mocked(marketJson).mockResolvedValue({
      capturedAt: Date.now(),
      value: { account_id: "owner.near", tokens: [...assets, { invalid: true }] },
    });
    const original = vi.mocked(callViewFunction).getMockImplementation();
    vi.mocked(callViewFunction).mockImplementation(async (contract, method, args, signal) => {
      if (contract === "token-104.near" && method === "ft_metadata") {
        return { blockHeight: 5, value: { symbol: "FINE", decimals: 40 } };
      }
      if (!original) {
        throw new Error("Missing contract reader.");
      }
      return original(contract, method, args, signal);
    });
    const result = await walletTokenHoldings("owner.near");
    expect(result.tokens).toHaveLength(106);
    expect(result.tokens.at(-1)).toMatchObject({
      assetId: "nep141:token-104.near",
      symbol: "FINE",
      decimals: 40,
    });
    expect(result.complete).toBe(false);
  });
  it("continues with native NEAR and manual contract lookup when discovery is unavailable", async () => {
    vi.mocked(marketJson).mockRejectedValue(new Error("Quota exhausted"));
    const result = await walletTokenHoldings("owner.near", ["nep141:missing.near"]);
    expect(result.tokens).toHaveLength(2);
    expect(result.note).toContain("could not be listed");
    expect((await walletTokenHolding("owner.near", "nep141:missing.near")).assetId).toBe(
      "nep141:missing.near",
    );
  });
  it("retains a zero balance when requested to reveal an existing allocation shortfall", async () => {
    const result = await walletTokenHoldings("owner.near", ["nep141:zero.near"]);
    expect(result.tokens.find((token) => token.assetId === "nep141:zero.near")?.balanceUnits).toBe("0");
  });
  it("does not invent an empty wallet or accept broken metadata", async () => {
    vi.mocked(callViewFunction).mockResolvedValue({
      blockHeight: 5,
      value: { symbol: "BAD", decimals: 900 },
    });
    await expect(walletTokenHolding("owner.near", "nep141:broken.near")).rejects.toMatchObject({
      code: "unavailable",
    });
    vi.mocked(viewNearBudgetBalance).mockRejectedValue(new Error("RPC outage"));
    vi.mocked(marketJson).mockRejectedValue(new Error("Indexer outage"));
    await expect(walletTokenHoldings("owner.near")).rejects.toMatchObject({ code: "unavailable" });
    await expect(walletTokenHolding("owner.near", "https://internal/")).rejects.toThrow();
  });
});
