import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { decimal } from "@/server/research/decimal";
import { type AgentPolicy, parseUsd, type Strategy } from "@/shared/agents";
import { minimumUnits, tokenUnitsSchema } from "@/shared/token-units";
import type { MarketPrice } from "./market-price";
import type { PricedHolding, RebalanceSignal } from "./rebalance";

const timestamp = z.number().int().nonnegative().nullable();
const triggerStateFields = z.strictObject({
  format: z.literal(1),
  phase: z.enum(["waiting", "holding", "completed"]),
  quantityUnits: tokenUnitsSchema,
  peakMicroUsd: tokenUnitsSchema,
  confirmationSince: timestamp,
  lastMarketAt: timestamp,
  lastSampleAt: timestamp,
  lastActionId: z.uuid().nullable(),
  pendingActionId: z.uuid().nullable(),
  needsReset: z.boolean(),
  exitTriggered: z.boolean(),
});
export const triggerStateSchema = triggerStateFields.pipe(
  triggerStateFields.refine((s) => (s.phase === "holding") === BigInt(s.quantityUnits) > 0n),
);
export type TriggerState = z.infer<typeof triggerStateSchema>;
export type TriggerStrategy = Extract<Strategy, { kind: "triggers" }>;
export const INITIAL_TRIGGER_STATE: TriggerState = {
  format: 1,
  phase: "waiting",
  quantityUnits: "0",
  peakMicroUsd: "0",
  confirmationSince: null,
  lastMarketAt: null,
  lastSampleAt: null,
  lastActionId: null,
  pendingActionId: null,
  needsReset: false,
  exitTriggered: false,
};
export interface TriggerDecision {
  readonly state: TriggerState;
  readonly signal:
    | (RebalanceSignal & {
        readonly purpose: "trigger_entry" | "trigger_exit";
        readonly referenceOutputPriceMicroUsd: string;
        readonly outputDecimals: number;
      })
    | null;
  readonly reason: string;
}

function sizedSignal(
  input: PricedHolding,
  output: PricedHolding,
  maximumMicroUsd: bigint,
): RebalanceSignal | null {
  const price = decimal(input.priceUsd);
  if (price.n <= 0n) {
    throw new ExecutionError("not_ready", "A positive reference price is required for sizing.");
  }
  // Round the input down; reserve only attributed holdings, never another agent's cash.
  const units = minimumUnits(
    input.units,
    (maximumMicroUsd * 10n ** BigInt(input.decimals) * price.d) / (price.n * 1_000_000n),
  );
  if (units <= 0n) {
    return null;
  }
  const denominator = 10n ** BigInt(input.decimals) * price.d;
  return {
    inputAssetId: input.assetId,
    outputAssetId: output.assetId,
    inputUnits: units.toString(),
    referenceInputMicroUsd: ((units * price.n * 1_000_000n + denominator - 1n) / denominator).toString(),
  };
}

/** Evaluates observed ticks only. Gaps reset confirmation; missed extrema and fills are never invented. */
export function triggerDecision(
  strategy: TriggerStrategy,
  policy: AgentPolicy,
  previous: TriggerState,
  tick: MarketPrice,
  asset: PricedHolding,
  quote: PricedHolding,
  now: number,
): TriggerDecision {
  if (
    tick.symbol !== strategy.asset ||
    tick.symbol !== asset.symbol ||
    quote.symbol !== strategy.quoteAsset ||
    tick.priceMicroUsd <= 0n ||
    now - tick.marketAt >= 5000 ||
    now - tick.capturedAt >= 5000 ||
    tick.marketAt > now + 1000 ||
    tick.capturedAt > now + 1000
  ) {
    throw new ExecutionError("not_ready", "A fresh matching market reference is required.");
  }
  const state = triggerStateSchema.parse(previous);
  const idle = (reason: string): TriggerDecision => ({ state, signal: null, reason });
  if (state.phase === "completed") {
    return idle("The reviewed trigger strategy has completed.");
  }
  if (state.lastMarketAt !== null && tick.marketAt <= state.lastMarketAt) {
    return idle("Waiting for a newer market tick.");
  }
  const gap = state.lastSampleAt === null || now - state.lastSampleAt > 10_000;
  state.lastMarketAt = tick.marketAt;
  state.lastSampleAt = now;
  if (gap) {
    state.confirmationSince = null;
  }
  const expired = now >= Date.parse(strategy.expiresAt);
  const market = tick.priceMicroUsd;
  if (state.phase === "holding") {
    if (BigInt(state.quantityUnits) > asset.units) {
      throw new ExecutionError(
        "not_ready",
        "The confirmed trigger position exceeds the agent's available holdings.",
      );
    }
    const peak = market > BigInt(state.peakMicroUsd) ? market : BigInt(state.peakMicroUsd);
    state.peakMicroUsd = peak.toString();
    const exit =
      state.exitTriggered ||
      expired ||
      (strategy.takeProfitPriceUsd !== null && market >= parseUsd(strategy.takeProfitPriceUsd)) ||
      (strategy.stopLossPriceUsd !== null && market <= parseUsd(strategy.stopLossPriceUsd)) ||
      (strategy.trailingStopBps !== null &&
        market * 10_000n <= peak * BigInt(10_000 - strategy.trailingStopBps));
    if (!exit) {
      return idle("Monitoring the confirmed position's exit conditions.");
    }
    state.exitTriggered = true;
    const signal = sizedSignal(
      { ...asset, units: BigInt(state.quantityUnits) },
      quote,
      parseUsd(policy.maxTradeUsd),
    );
    const quotePrice = decimal(quote.priceUsd);
    return {
      state,
      signal: signal
        ? {
            ...signal,
            purpose: "trigger_exit",
            referenceOutputPriceMicroUsd: ((quotePrice.n * 1_000_000n) / quotePrice.d).toString(),
            outputDecimals: quote.decimals,
          }
        : null,
      reason: "An exit condition was observed; checking a fresh execution quote.",
    };
  }
  if (expired) {
    state.phase = "completed";
    return idle("The entry window expired without an open position.");
  }
  const trigger = parseUsd(strategy.triggerPriceUsd);
  const condition = strategy.condition === "buy_above" ? market >= trigger : market <= trigger;
  if (state.needsReset) {
    if (!condition) {
      state.needsReset = false;
    }
    state.confirmationSince = null;
    return idle("Waiting for the entry condition to reset before re-arming.");
  }
  if (
    !condition ||
    (strategy.condition === "buy_above" &&
      market * 10_000n > trigger * BigInt(10_000 + strategy.maxChaseBps)) ||
    (strategy.stopLossPriceUsd !== null && market <= parseUsd(strategy.stopLossPriceUsd)) ||
    (strategy.takeProfitPriceUsd !== null && market >= parseUsd(strategy.takeProfitPriceUsd))
  ) {
    state.confirmationSince = null;
    return idle("Waiting for the reviewed entry price within its chase and exit limits.");
  }
  state.confirmationSince ??= now;
  if (now - state.confirmationSince < strategy.confirmationSeconds * 1000) {
    return idle("The entry condition is still being confirmed.");
  }
  const size = parseUsd(strategy.orderSizeUsd);
  if (size > parseUsd(policy.maxTradeUsd)) {
    return idle("The configured entry size exceeds the per-trade limit. Review the strategy or its limit.");
  }
  const signal = sizedSignal(quote, asset, size);
  if (signal && BigInt(signal.referenceInputMicroUsd) + 1n < size) {
    return idle("The allocated quote balance does not cover the configured entry size.");
  }
  return {
    state,
    signal: signal
      ? {
          ...signal,
          purpose: "trigger_entry",
          referenceOutputPriceMicroUsd: market.toString(),
          outputDecimals: asset.decimals,
        }
      : null,
    reason: signal
      ? "The entry condition was observed; checking a fresh execution quote."
      : "No allocated quote balance is available for this entry.",
  };
}
