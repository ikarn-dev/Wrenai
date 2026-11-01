import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { decimal } from "@/server/research/decimal";
import {
  confirmedPublicLeaderSwap,
  copyEventId,
  type PublicSwap,
  type PublicSwapFeed,
} from "@/server/research/explorer-contracts";
import { type AgentPolicy, parseUsd, type Strategy } from "@/shared/agents";
import type { PricedHolding, RebalanceSignal } from "./rebalance";

export const copyStateSchema = z.strictObject({
  format: z.literal("copy-trading-v1"),
  processed: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
  pendingActionId: z.uuid().nullable(),
});
export type CopyState = z.infer<typeof copyStateSchema>;
export const INITIAL_COPY_STATE: CopyState = {
  format: "copy-trading-v1",
  processed: [],
  pendingActionId: null,
};
type CopyStrategy = Extract<Strategy, { kind: "copy_trading" }>;

export interface CopySignal extends RebalanceSignal {
  readonly purpose: "copy_trade";
  readonly copyTrade: { readonly eventId: string; readonly event: PublicSwap };
}

/** Stable across retries, pause/resume and worker takeover; a schedule slot never authorizes a second copy. */
export function copyRequestId(agentId: string, strategyVersion: number, eventId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["copy-trade:v1", agentId, strategyVersion, eventId]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function eligibleLeaderSwap(strategy: CopyStrategy, event: PublicSwap, now: number): boolean {
  const createdAt = Date.parse(event.createdAt);
  return (
    confirmedPublicLeaderSwap(event, strategy.leaderAccountId) &&
    createdAt <= now &&
    now - createdAt <= strategy.maxSignalAgeSeconds * 1000
  );
}

/** Compare exact unit ratios, including the follower's worst permitted output, rather than display USD rates. */
export function copyPriceAllowed(
  strategy: CopyStrategy,
  event: PublicSwap,
  inputUnits: bigint,
  minOutputUnits: bigint,
): boolean {
  return (
    inputUnits > 0n &&
    minOutputUnits > 0n &&
    minOutputUnits * BigInt(event.amountIn) * 10_000n >=
      inputUnits * BigInt(event.amountOut) * BigInt(10_000 - strategy.maxPriceDeviationBps)
  );
}

export function copyDecision(
  strategy: CopyStrategy,
  policy: AgentPolicy,
  previous: CopyState,
  feed: PublicSwapFeed,
  holdings: readonly PricedHolding[],
  activationAt: number,
  now: number,
): {
  readonly signal: CopySignal | null;
  readonly state: CopyState;
  readonly completed: boolean;
  readonly reason: string;
} {
  const cutoff = Math.max(activationAt, now - strategy.maxSignalAgeSeconds * 1000);
  const state = copyStateSchema.parse({
    ...previous,
    processed: previous.processed.filter((event) => event.createdAt >= cutoff),
    pendingActionId: null,
  });
  if (now >= Date.parse(strategy.expiresAt)) {
    return { signal: null, state, completed: true, reason: "The reviewed Copy Trading strategy expired." };
  }
  if (feed.capturedAt > now || now - feed.capturedAt >= 5000) {
    throw new ExecutionError("not_ready", "The public leader feed is stale.");
  }
  const ordered = feed.swaps.toSorted(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || copyEventId(a).localeCompare(copyEventId(b)),
  );
  if (ordered.length === 1000 && Date.parse(ordered[0]?.createdAt ?? "") >= cutoff) {
    throw new ExecutionError(
      "not_ready",
      "The public feed cannot cover the reviewed signal window. No backfill trades were placed.",
    );
  }
  const seen = new Set(state.processed.map((event) => event.id));
  const event = ordered.find(
    (swap) =>
      eligibleLeaderSwap(strategy, swap, now) &&
      Date.parse(swap.createdAt) >= cutoff &&
      !seen.has(copyEventId(swap)) &&
      holdings.some((h) => h.assetId === swap.originAsset) &&
      holdings.some((h) => h.assetId === swap.destinationAsset),
  );
  if (!event) {
    return {
      signal: null,
      state,
      completed: false,
      reason: "No new supported public leader swap within the reviewed window.",
    };
  }
  const eventId = copyEventId(event);
  const next = {
    ...state,
    processed: [...state.processed, { id: eventId, createdAt: Date.parse(event.createdAt) }].slice(-1000),
  };
  const input = holdings.find((holding) => holding.assetId === event.originAsset);
  const size = parseUsd(strategy.orderSizeUsd);
  if (!input || size > parseUsd(policy.maxTradeUsd)) {
    return {
      signal: null,
      state: next,
      completed: false,
      reason: "Leader swap skipped: the configured copy size exceeds the per-trade limit.",
    };
  }
  const price = decimal(input.priceUsd);
  if (price.n <= 0n || input.decimals < 0 || input.decimals > 36 || !Number.isInteger(input.decimals)) {
    throw new ExecutionError("not_ready", "The copied input asset has no valid current valuation.");
  }
  // Round input units down; an underfunded copy is skipped, never silently resized or borrowed.
  const denominator = price.n * 1_000_000n;
  const scale = 10n ** BigInt(input.decimals) * price.d;
  const units = (size * scale) / denominator;
  if (units <= 0n || units > input.units) {
    return {
      signal: null,
      state: next,
      completed: false,
      reason: "Leader swap skipped: this agent has insufficient allocated input tokens.",
    };
  }
  return {
    signal: {
      purpose: "copy_trade",
      inputAssetId: event.originAsset,
      outputAssetId: event.destinationAsset,
      inputUnits: units.toString(),
      referenceInputMicroUsd: ((units * denominator + scale - 1n) / scale).toString(),
      copyTrade: { eventId, event },
    },
    state: next,
    completed: false,
    reason: "Checking a new confirmed public leader swap against the follower's limits.",
  };
}
