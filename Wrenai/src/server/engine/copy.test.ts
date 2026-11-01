import { describe, expect, it } from "vitest";
import { copyEventId, type PublicSwap, publicSwapSchema } from "@/server/research/explorer-contracts";
import { DEFAULT_POLICY, strategySchema } from "@/shared/agents";
import {
  copyDecision,
  copyPriceAllowed,
  copyRequestId,
  eligibleLeaderSwap,
  INITIAL_COPY_STATE,
} from "./copy";
import type { PricedHolding } from "./rebalance";

const now = Date.parse("2026-11-01T10:00:00Z");
const parsed = strategySchema.parse({
  kind: "copy_trading",
  leaderAccountId: "leader.near",
  assets: ["NEAR", "USDC"],
  orderSizeUsd: "10",
  maxSignalAgeSeconds: 120,
  maxPriceDeviationBps: 100,
  expiresAt: new Date(now + 3600_000).toISOString(),
});
if (parsed.kind !== "copy_trading") {
  throw new Error("Invalid offline copy strategy");
}
const strategy = parsed;
const event = publicSwapSchema.parse({
  originAsset: "nep141:usdc.near",
  destinationAsset: "nep141:wrap.near",
  depositAddress: "public-swap-deposit",
  depositMemo: null,
  status: "SUCCESS",
  createdAt: new Date(now - 10_000).toISOString(),
  intentHashes: "public-intent-hash",
  amountIn: "10000000",
  amountOut: "2500000000000000000000000",
  senders: ["leader.near"],
  originChainTxHashes: ["public-source-hash"],
  depositType: "ORIGIN_CHAIN",
  recipientType: "INTENTS",
});
const holdings: readonly PricedHolding[] = [
  { symbol: "USDC", assetId: event.originAsset, decimals: 6, units: 20_000_000n, priceUsd: "1" },
  { symbol: "NEAR", assetId: event.destinationAsset, decimals: 24, units: 0n, priceUsd: "4" },
];
function decide(swaps: readonly PublicSwap[] = [event], assets = holdings) {
  return copyDecision(
    strategy,
    DEFAULT_POLICY,
    INITIAL_COPY_STATE,
    { capturedAt: now, swaps: [...swaps] },
    assets,
    now - 60_000,
    now,
  );
}

describe("reviewed public Copy Trading", () => {
  it("sizes a fixed copy from owned inputs and checkpoints the exact public event", () => {
    const result = decide();
    expect(result.signal).toMatchObject({
      purpose: "copy_trade",
      inputAssetId: event.originAsset,
      outputAssetId: event.destinationAsset,
      inputUnits: "10000000",
      referenceInputMicroUsd: "10000000",
      copyTrade: { eventId: copyEventId(event), event },
    });
    expect(
      copyDecision(
        strategy,
        DEFAULT_POLICY,
        result.state,
        { capturedAt: now, swaps: [event] },
        holdings,
        now - 60_000,
        now,
      ).signal,
    ).toBeNull();
  });

  it.each([
    { status: "PROCESSING" as const },
    { status: "REFUNDED" as const },
    { senders: ["recipient-only.near"] },
    { senders: ["leader.near", "joint.near"] },
    { depositType: "CONFIDENTIAL_INTENTS" as const },
    { recipientType: "CONFIDENTIAL_INTENTS" as const },
    { originChainTxHashes: [] },
    { intentHashes: "" },
    { amountOut: "0" },
    { createdAt: new Date(now - 120_001).toISOString() },
    { createdAt: new Date(now + 1).toISOString() },
    { destinationAsset: "nep141:unreviewed.near" },
  ])("does not treat unsupported activity as a leader instruction: %j", (change) => {
    expect(decide([{ ...event, ...change }]).signal).toBeNull();
  });

  it("ignores swaps from before activation and stops at the reviewed expiry", () => {
    expect(
      copyDecision(
        strategy,
        DEFAULT_POLICY,
        INITIAL_COPY_STATE,
        { capturedAt: now, swaps: [event] },
        holdings,
        now - 1,
        now,
      ).signal,
    ).toBeNull();
    expect(
      copyDecision(
        { ...strategy, expiresAt: new Date(now).toISOString() },
        DEFAULT_POLICY,
        INITIAL_COPY_STATE,
        { capturedAt: now, swaps: [] },
        holdings,
        now - 60_000,
        now,
      ).completed,
    ).toBe(true);
    expect(eligibleLeaderSwap(strategy, event, now)).toBe(true);
  });

  it("never resizes an underfunded trade or exceeds the user's per-trade ceiling", () => {
    const tooSmall = holdings.map((asset) => ({ ...asset, units: 1n }));
    expect(decide([event], tooSmall).signal).toBeNull();
    expect(
      copyDecision(
        strategy,
        { ...DEFAULT_POLICY, maxTradeUsd: "9" },
        INITIAL_COPY_STATE,
        { capturedAt: now, swaps: [event] },
        holdings,
        now - 60_000,
        now,
      ).signal,
    ).toBeNull();
  });

  it("uses worst-case exact unit ratios and stable event identities, including a memo", () => {
    const boundary = (BigInt(event.amountOut) * 99n) / 100n;
    expect(copyPriceAllowed(strategy, event, 10_000_000n, boundary)).toBe(true);
    expect(copyPriceAllowed(strategy, event, 10_000_000n, boundary - 1n)).toBe(false);
    const id = copyEventId(event);
    expect(copyEventId({ ...event, amountOut: "1" })).toBe(id);
    expect(copyEventId({ ...event, depositMemo: "different" })).not.toBe(id);
    expect(copyRequestId("agent-a", 1, id)).toMatch(/^[a-f0-9-]{36}$/);
    expect(copyRequestId("agent-a", 1, id)).toBe(copyRequestId("agent-a", 1, id));
    expect(copyRequestId("agent-a", 1, id)).not.toBe(copyRequestId("agent-b", 1, id));
  });

  it("blocks stale snapshots and a page that cannot cover the eligible signal window", () => {
    expect(() =>
      copyDecision(
        strategy,
        DEFAULT_POLICY,
        INITIAL_COPY_STATE,
        { capturedAt: now - 5000, swaps: [] },
        holdings,
        now - 60_000,
        now,
      ),
    ).toThrow("stale");
    expect(() =>
      decide(Array.from({ length: 1000 }, (_, i) => ({ ...event, depositAddress: `deposit-${i}` }))),
    ).toThrow("cover");
  });

  it("rejects malformed strategy amounts and duplicate assets without throwing outside safeParse", () => {
    expect(strategySchema.safeParse({ ...strategy, orderSizeUsd: "invalid" }).success).toBe(false);
    expect(strategySchema.safeParse({ ...strategy, assets: ["NEAR", "NEAR"] }).success).toBe(false);
    expect(strategySchema.safeParse({ ...strategy, leaderAccountId: "https://internal" }).success).toBe(
      false,
    );
  });
});
