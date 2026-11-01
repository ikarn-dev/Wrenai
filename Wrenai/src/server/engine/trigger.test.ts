import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, strategySchema } from "@/shared/agents";
import {
  INITIAL_TRIGGER_STATE,
  type TriggerState,
  type TriggerStrategy,
  triggerDecision,
  triggerStateSchema,
} from "./trigger";

const now = 1_800_000_000_000;
const asset = {
  symbol: "NEAR",
  assetId: "nep141:wrap.near",
  decimals: 24,
  units: 100n * 10n ** 24n,
  priceUsd: "2",
} as const;
const quote = {
  symbol: "USDC",
  assetId: "nep141:offline-usdc.near",
  decimals: 6,
  units: 100_000_000n,
  priceUsd: "1",
} as const;
function strategy(overrides: Partial<TriggerStrategy> = {}): TriggerStrategy {
  const parsed = strategySchema.parse({
    kind: "triggers",
    asset: "NEAR",
    quoteAsset: "USDC",
    condition: "buy_above",
    triggerPriceUsd: "2",
    orderSizeUsd: "10",
    takeProfitPriceUsd: "3",
    stopLossPriceUsd: "1",
    trailingStopBps: 500,
    maxChaseBps: 100,
    confirmationSeconds: 0,
    expiresAt: new Date(now + 86_400_000).toISOString(),
    rearm: false,
    ...overrides,
  });
  if (parsed.kind !== "triggers") {
    throw new Error("Invalid trigger fixture.");
  }
  return parsed;
}
function evaluate(
  price: bigint,
  state: TriggerState = INITIAL_TRIGGER_STATE,
  time = now,
  settings = strategy(),
): ReturnType<typeof triggerDecision> {
  return triggerDecision(
    settings,
    DEFAULT_POLICY,
    state,
    { symbol: "NEAR", priceMicroUsd: price, marketAt: time, capturedAt: time },
    { ...asset, priceUsd: `${price / 1_000_000n}.${(price % 1_000_000n).toString().padStart(6, "0")}` },
    quote,
    time,
  );
}

describe("deterministic observed-tick triggers", () => {
  it("sizes the reviewed entry exactly, rejects chasing, and does not mutate previous state", () => {
    expect(evaluate(2_000_000n).signal).toMatchObject({
      purpose: "trigger_entry",
      inputUnits: "10000000",
      referenceInputMicroUsd: "10000000",
    });
    expect(evaluate(2_020_001n).signal).toBeNull();
    expect(evaluate(1_900_000n).signal).toBeNull();
    expect(INITIAL_TRIGGER_STATE.lastMarketAt).toBeNull();
  });
  it("requires continuous confirmation, resets after a gap and ignores duplicate/out-of-order ticks", () => {
    const config = strategy({ confirmationSeconds: 10 });
    const first = evaluate(2_000_000n, INITIAL_TRIGGER_STATE, now, config);
    expect(first.signal).toBeNull();
    const second = evaluate(2_000_000n, first.state, now + 5000, config);
    expect(second.signal).toBeNull();
    expect(evaluate(2_000_000n, second.state, now + 10_000, config).signal).not.toBeNull();
    expect(evaluate(2_000_000n, first.state, now + 11_000, config).signal).toBeNull();
    expect(evaluate(2_000_000n, second.state, now + 4000, config).state.lastMarketAt).toBe(now + 5000);
  });
  it("sizes exits to the confirmed position, uses persisted trailing peaks and enforces the trade cap", () => {
    const holding: TriggerState = {
      ...INITIAL_TRIGGER_STATE,
      phase: "holding",
      quantityUnits: (3n * 10n ** 24n).toString(),
      peakMicroUsd: "2500000",
    };
    const exit = evaluate(2_300_000n, holding);
    expect(exit.signal).toMatchObject({ purpose: "trigger_exit", inputUnits: (3n * 10n ** 24n).toString() });
    const larger = { ...holding, quantityUnits: (10n * 10n ** 24n).toString() };
    expect(evaluate(3_000_000n, larger).signal?.inputUnits).toBe(((10n * 10n ** 24n) / 3n).toString());
    expect(evaluate(2_450_000n, holding).signal).toBeNull();
    expect(
      evaluate(2_450_000n, { ...exit.state, quantityUnits: (10n ** 24n).toString() }, now + 5000).signal
        ?.purpose,
    ).toBe("trigger_exit");
  });
  it("expires flat strategies, closes a held position on expiry and waits for reset before rearming", () => {
    const expired = strategy({ expiresAt: new Date(now - 1).toISOString() });
    expect(evaluate(2_000_000n, INITIAL_TRIGGER_STATE, now, expired).state.phase).toBe("completed");
    const holding: TriggerState = {
      ...INITIAL_TRIGGER_STATE,
      phase: "holding",
      quantityUnits: (10n ** 24n).toString(),
    };
    expect(evaluate(2_000_000n, holding, now, expired).signal?.purpose).toBe("trigger_exit");
    const reset = { ...INITIAL_TRIGGER_STATE, needsReset: true };
    expect(evaluate(2_000_000n, reset).signal).toBeNull();
    const below = evaluate(1_900_000n, reset);
    expect(below.state.needsReset).toBe(false);
    expect(evaluate(2_000_000n, below.state, now + 5000).signal).not.toBeNull();
  });
  it("blocks stale, foreign and impossible position inputs instead of inventing usable observations", () => {
    expect(() =>
      triggerDecision(
        strategy(),
        DEFAULT_POLICY,
        INITIAL_TRIGGER_STATE,
        { symbol: "NEAR", priceMicroUsd: 2_000_000n, marketAt: now - 5000, capturedAt: now },
        asset,
        quote,
        now,
      ),
    ).toThrow("fresh");
    expect(() =>
      evaluate(2_000_000n, {
        ...INITIAL_TRIGGER_STATE,
        phase: "holding",
        quantityUnits: (101n * 10n ** 24n).toString(),
      }),
    ).toThrow("available holdings");
    expect(triggerStateSchema.safeParse({ ...INITIAL_TRIGGER_STATE, phase: "holding" }).success).toBe(false);
    expect(triggerStateSchema.safeParse({ ...INITIAL_TRIGGER_STATE, quantityUnits: "NaN" }).success).toBe(
      false,
    );
  });
});
