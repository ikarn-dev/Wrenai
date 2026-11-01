import { decimal } from "@/server/research/decimal";
import { type AgentPolicy, type AssetSymbol, parseUsd, type Strategy } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";

export interface PricedHolding {
  readonly symbol: AssetSymbol;
  readonly assetId: string;
  readonly decimals: number;
  readonly units: bigint;
  readonly priceUsd: string;
}
export interface RebalanceSignal {
  readonly inputAssetId: string;
  readonly outputAssetId: string;
  readonly inputUnits: string;
  readonly referenceInputMicroUsd: string;
}

/** Nets the largest surplus against the largest deficit; never sizes from another agent's holdings. */
export function rebalanceSignal(
  strategy: Extract<Strategy, { kind: "rebalancer" }>,
  policy: AgentPolicy,
  holdings: readonly PricedHolding[],
): RebalanceSignal | null {
  if (
    holdings.length !== strategy.targets.length ||
    new Set(holdings.map((h) => h.symbol)).size !== holdings.length ||
    new Set(holdings.map((h) => h.assetId)).size !== holdings.length
  ) {
    throw new Error("The complete reviewed portfolio is required for rebalancing.");
  }
  const priced = holdings.map((holding) => {
    const target = strategy.targets.find((t) => t.symbol === holding.symbol);
    const price = decimal(holding.priceUsd);
    if (
      !target ||
      price.n <= 0n ||
      holding.units < 0n ||
      !Number.isInteger(holding.decimals) ||
      holding.decimals < 0 ||
      holding.decimals > 36
    ) {
      throw new Error("The portfolio contains an invalid asset, price or quantity.");
    }
    // Floor indicative portfolio values. Final trade sizing is independently checked against a fresh signed quote.
    const value = (holding.units * price.n * 1_000_000n) / (10n ** BigInt(holding.decimals) * price.d);
    return { holding, price, value, target };
  });
  const total = priced.reduce((sum, p) => sum + p.value, 0n);
  if (total === 0n) {
    return null;
  }
  const drifts = priced.map((p) => ({
    ...p,
    difference: p.value * 10_000n - total * BigInt(p.target.weightBps),
  }));
  const sell = drifts.toSorted((a, b) =>
    a.difference > b.difference ? -1 : a.difference < b.difference ? 1 : 0,
  )[0];
  const buy = drifts.toSorted((a, b) =>
    a.difference < b.difference ? -1 : a.difference > b.difference ? 1 : 0,
  )[0];
  if (
    !sell ||
    !buy ||
    sell.difference <= 0n ||
    buy.difference >= 0n ||
    (sell.difference < total * BigInt(strategy.driftBps) &&
      -buy.difference < total * BigInt(strategy.driftBps))
  ) {
    return null;
  }
  const value = [sell.difference / 10_000n, -buy.difference / 10_000n, parseUsd(policy.maxTradeUsd)].reduce(
    minimumUnits,
  );
  // Round the input down so the proposed debit cannot exceed the selected dollar amount.
  const units = (value * 10n ** BigInt(sell.holding.decimals) * sell.price.d) / (sell.price.n * 1_000_000n);
  if (units <= 0n || units > sell.holding.units) {
    return null;
  }
  const reference =
    (units * sell.price.n * 1_000_000n + 10n ** BigInt(sell.holding.decimals) * sell.price.d - 1n) /
    (10n ** BigInt(sell.holding.decimals) * sell.price.d);
  return {
    inputAssetId: sell.holding.assetId,
    outputAssetId: buy.holding.assetId,
    inputUnits: units.toString(),
    referenceInputMicroUsd: reference.toString(),
  };
}
