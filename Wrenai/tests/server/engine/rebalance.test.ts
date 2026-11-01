import { describe, expect, it } from "vitest";
import { type PricedHolding, rebalanceSignal } from "@/server/engine/rebalance";
import { DEFAULT_POLICY, strategySchema } from "@/shared/agents";

const strategy = strategySchema.parse({
  kind: "rebalancer",
  targets: [
    { symbol: "NEAR", weightBps: 5000 },
    { symbol: "USDC", weightBps: 5000 },
  ],
  driftBps: 500,
  intervalSeconds: 60,
});
function signal(nearUnits: bigint, usdcUnits: bigint, priceUsd = "2"): ReturnType<typeof rebalanceSignal> {
  if (strategy.kind !== "rebalancer") {
    throw new Error("Invalid fixture.");
  }
  return rebalanceSignal(strategy, DEFAULT_POLICY, [
    { symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24, units: nearUnits, priceUsd },
    { symbol: "USDC", assetId: "nep141:offline-usdc.near", decimals: 6, units: usdcUnits, priceUsd: "1" },
  ]);
}
describe("deterministic owned-portfolio rebalancing", () => {
  it("does nothing inside the reviewed no-trade band or with no funds", () => {
    expect(signal(25n * 10n ** 24n, 50_000_000n)).toBeNull();
    expect(signal(26n * 10n ** 24n, 50_000_000n)).toBeNull();
    expect(signal(0n, 0n)).toBeNull();
  });
  it("nets a surplus into a deficit and respects the per-trade dollar cap", () => {
    expect(signal(50n * 10n ** 24n, 0n)).toEqual({
      inputAssetId: "nep141:wrap.near",
      outputAssetId: "nep141:offline-usdc.near",
      inputUnits: (5n * 10n ** 24n).toString(),
      referenceInputMicroUsd: "10000000",
    });
    expect(signal(0n, 100_000_000n)?.inputUnits).toBe("10000000");
  });
  it("rounds against overspending even at fractional prices and 24 token decimals", () => {
    const result = signal(50n * 10n ** 24n, 0n, "3.123456789123456789");
    expect(result).not.toBeNull();
    expect(BigInt(result?.referenceInputMicroUsd ?? "0")).toBeLessThanOrEqual(10_000_000n);
  });
  it("rejects incomplete portfolios and non-positive prices", () => {
    if (strategy.kind !== "rebalancer") {
      throw new Error("Invalid fixture.");
    }
    const holdings: readonly PricedHolding[] = [
      { symbol: "NEAR", assetId: "nep141:wrap.near", decimals: 24, units: 10n ** 24n, priceUsd: "2" },
    ];
    expect(() => rebalanceSignal(strategy, DEFAULT_POLICY, holdings)).toThrow("complete reviewed");
    expect(() => signal(1n, 1n, "0")).toThrow("invalid");
  });
});
