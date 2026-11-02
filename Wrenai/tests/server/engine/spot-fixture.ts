import type { SpotInstruction, SpotSnapshot } from "@/server/engine/spot-instructions";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { DEFAULT_POLICY } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";

export const baseAsset = {
  symbol: "nep141:wrap.near",
  assetId: "nep141:wrap.near",
  tokenSymbol: "NEAR",
  blockchain: "near",
  contractAddress: "wrap.near",
  decimals: 6,
} as const;
export const cashAsset = {
  symbol: "nep141:usd.near",
  assetId: "nep141:usd.near",
  tokenSymbol: "USD",
  blockchain: "near",
  contractAddress: "usd.near",
  decimals: 6,
} as const;
export const policy = {
  ...DEFAULT_POLICY,
  approvalMode: "autonomous",
  cooldownSeconds: 0,
  allowRiskReducingExits: true,
} as const;
export const noExits = { takeProfitPrice: null, stopLossPrice: null, trailingStopBps: null } as const;
export function instruction(now: number, fields: Record<string, unknown> = {}): SpotInstruction {
  const parsed = agentInstructionSchema.parse({
    format: 2,
    kind: "spot_trader",
    payAssetId: cashAsset.assetId,
    buyAssetId: baseAsset.assetId,
    priceUnit: "usd",
    side: "buy",
    amountUnits: "1000000",
    entry: { type: "market" },
    exits: noExits,
    expiresAt: new Date(now + 3600_000).toISOString(),
    ...fields,
  });
  if (
    parsed.kind !== "spot_trader" &&
    parsed.kind !== "dca" &&
    parsed.kind !== "buy_the_dip" &&
    parsed.kind !== "sell_the_top"
  ) {
    throw new Error("Expected a spot instruction fixture");
  }
  return parsed;
}
export function quote(now: number, overrides: Partial<TradeQuote> = {}): TradeQuote {
  return {
    provider: "oneclick",
    scope: "confidential",
    inputAssetId: cashAsset.assetId,
    outputAssetId: baseAsset.assetId,
    inputUnits: "1000000",
    outputUnits: "1000000",
    minOutputUnits: "1000000",
    inputMicroUsd: "1000000",
    outputMicroUsd: "1000000",
    slippageBps: 50,
    appFeeBps: 0,
    capturedAt: now,
    expiresAt: now + 15_000,
    quoteHash: "a".repeat(64),
    recipient: "owner.near",
    refundTo: "owner.near",
    feeNote: "Offline provider observation",
    ...overrides,
  };
}
export function snapshot(now: number, overrides: Partial<SpotSnapshot> = {}): SpotSnapshot {
  return {
    base: baseAsset,
    cash: cashAsset,
    baseOwned: 20_000_000n,
    cashOwned: 20_000_000n,
    price: { n: 1n, d: 1n, observedAt: now },
    quote: quote(now),
    ...overrides,
  };
}
