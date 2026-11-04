import { parse } from "lossless-json";
import type { MemeInstruction } from "@/server/engine/meme-state";
import { SQUINT_CHECKS, type SquintReport, squintReportSchema } from "@/server/squint/contracts";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { type TradeAsset, tradeAssetSchema } from "@/shared/trade-preview";

export const memeAsset: TradeAsset = tradeAssetSchema.parse({
  assetId: "nep141:fixture.nearlytrade.near",
  symbol: "nep141:fixture.nearlytrade.near",
  tokenSymbol: "FIX",
  blockchain: "near",
  contractAddress: "fixture.nearlytrade.near",
  decimals: 18,
});
export const cashAsset: TradeAsset = tradeAssetSchema.parse({
  assetId: "nep141:wrap.near",
  symbol: "nep141:wrap.near",
  tokenSymbol: "wNEAR",
  blockchain: "near",
  contractAddress: "wrap.near",
  decimals: 24,
});
export function rawReport(now: number, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: "fixture.nearlytrade.near",
    symbol: "FIX",
    name: "Fixture",
    creator: "creator.near",
    created_at: new Date(now - 120000).toISOString(),
    checked_at: new Date(now).toISOString(),
    verdict: "clean",
    risk: 0,
    launchpad: { id: "nearly", name: "Nearly" },
    checks: SQUINT_CHECKS.map((id) => ({
      id,
      label: id,
      status: "good",
      headline: "Observed fixture finding",
      detail: "",
    })),
    market: { liquidity_near: 10000, holders: 20, holders_capped: false, fdv_usd: 100000 },
    tax: { status: "none", buy_pct: 0, sell_pct: 0 },
    holders: [{ account: "holder.near", share: 0.05, tags: [] }],
    clusters: [{ share: 0.05, wallets: ["holder.near"] }],
    coverage: { wallets_traced: 20, wallets_checked: 20, transfers_complete: true },
    supply: { pool: 0.9, dev: 0.01, snipers: 0, linked: 0.05, holders: 0.04, rest: 0 },
    ...changes,
  };
}
export function reportFixture(now: number, changes: Record<string, unknown> = {}): SquintReport {
  return squintReportSchema.parse(
    parse(JSON.stringify(rawReport(now, changes)), null, (number: string) => number),
  );
}
export function hunterInstruction(now: number, changes: Partial<MemeInstruction> = {}): MemeInstruction {
  const parsed = agentInstructionSchema.parse({
    format: 2,
    kind: "meme_hunter",
    payAssetId: cashAsset.assetId,
    amountUnits: "1000000000000000000000000",
    maximumAgeSeconds: 3600,
    minimumLiquidityUsd: "1000",
    maximumHolderBps: 1000,
    maximumPriceImpactBps: 500,
    priceUnit: "usd",
    maximumPositions: 2,
    exits: { takeProfitPrice: "2", stopLossPrice: "0.5", trailingStopBps: 1000 },
    expiresAt: new Date(now + 3600000).toISOString(),
    onExpiry: "close",
    ...changes,
  });
  if (parsed.kind !== "meme_hunter") {
    throw new Error("Expected a hunter instruction fixture.");
  }
  return parsed;
}
