import {
  memeEvidenceFixture,
  memeQuote,
  memeStateFixture,
  memeTestContext,
  saveMemeState,
} from "@tests/server/engine/meme-context";
import { cashAsset, memeAsset, reportFixture } from "@tests/server/squint/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planMemeCheck } from "@/server/engine/meme-check";
import { type MemeState, memeStateSchema } from "@/server/engine/meme-state";
import { currentAgentStrategy, readAgentTradeAssets } from "@/server/execution/asset-review";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { memeSubmissionCheck } from "@/server/execution/meme-reference";
import { assignInventory } from "@/server/positions/attribution";
import { SquintUnavailable } from "@/server/squint/contracts";
import type { TradeAsset } from "@/shared/trade-preview";

const io = vi.hoisted(() => ({
  coins: vi.fn(),
  report: vi.fn(),
  profile: vi.fn(),
  registry: vi.fn(),
  quote: vi.fn(),
  price: vi.fn(),
  sync: vi.fn(),
  nativeSync: vi.fn(),
  metadata: vi.fn(),
  nativeQuote: vi.fn(),
  reverse: vi.fn(),
  root: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/squint/client", () => ({ squintCoins: io.coins, squintReport: io.report }));
vi.mock("@/server/squint/near-profile", () => ({ verifyMemeContract: io.profile }));
vi.mock("@/server/research/intents", () => ({ intentTokens: io.registry }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  freshDryQuote: io.quote,
}));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: io.sync }));
vi.mock("@/server/engine/meme-price", () => ({ memeMarketPrice: io.price, memeDclQuote: io.reverse }));
vi.mock("@/server/execution/rhea/inventory", () => ({
  nativeTokenAsset: io.metadata,
  synchronizeNativeInventory: io.nativeSync,
}));
vi.mock("@/server/execution/rhea/quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/rhea/quote")>()),
  quoteRhea: io.nativeQuote,
}));
vi.mock("@/server/trading-accounts/vault", async (original) => ({
  ...(await original<typeof import("@/server/trading-accounts/vault")>()),
  activeTradingAccount: io.root,
}));
let context: Awaited<ReturnType<typeof memeTestContext>>;
let state: MemeState;
beforeEach(async () => {
  vi.resetAllMocks();
  context = await memeTestContext();
  state = memeStateFixture(Date.parse(context.instruction.expiresAt) - 3600000);
  io.registry.mockRejectedValue(new Error("Intents registry unavailable"));
  io.coins.mockResolvedValue([]);
  io.report.mockImplementation(async () => reportFixture(Date.now()));
  io.profile.mockImplementation(async () =>
    memeEvidenceFixture(Date.parse(context.instruction.expiresAt) - 3600000),
  );
  io.price.mockImplementation(async () => ({ n: 1n, d: 1n, observedAt: Date.now() }));
  io.nativeSync.mockResolvedValue(undefined);
  io.metadata.mockImplementation(async (id: string) => (id === cashAsset.assetId ? cashAsset : memeAsset));
  io.root.mockResolvedValue({ backupConfirmedAt: Date.now(), nativeAccountId: "a".repeat(64) });
  io.reverse.mockResolvedValue(980000000000000000000000n);
  io.nativeQuote.mockImplementation(async (input: TradeAsset, output: TradeAsset, inputUnits: string) => ({
    poolId: state.positions[0]?.evidence.poolId,
    input,
    output,
    inputUnits,
    outputUnits: input.assetId === cashAsset.assetId ? "2000000000000000000" : "3000000000000000000000000",
    minimumOutputUnits:
      input.assetId === cashAsset.assetId ? "1990000000000000000" : "2990000000000000000000000",
    inputMicroUsd: input.assetId === cashAsset.assetId ? "2000000" : "6000000",
    outputMicroUsd: output.assetId === cashAsset.assetId ? "6000000" : null,
    observedAt: Date.now(),
    expiresAt: Date.now() + 15000,
    slippageBps: 50,
  }));
});
afterEach(async () => {
  await context.postgres.close();
});
async function plan(raw: MemeState): Promise<Awaited<ReturnType<typeof planMemeCheck>>> {
  return planMemeCheck(
    context.db,
    await currentAgentStrategy(context.db, "owner", context.agentId, 1),
    context.instruction,
    JSON.stringify(raw),
  );
}
async function nativeFunds(assetId: string, units: string): Promise<void> {
  const syncToken = await beginInventorySync(context.db, "owner", "native_near");
  await finishInventorySync(context.db, "owner", {
    scope: "native_near",
    syncToken,
    balances: [{ assetId, amountUnits: units }],
  });
  await assignInventory(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "native_near",
    assetId,
    quantityUnits: units,
    capitalMicroUsd: "2000000",
    costBasisMicroUsd: "2000000",
    sourceReference: "offline-native-hunter",
    evidenceHash: "a".repeat(64),
  });
}
describe("native hunter route independence and reviewed metadata", () => {
  it("continues past rejected newest listings while retaining bounded scans and old-state compatibility", async () => {
    await nativeFunds(cashAsset.assetId, "10000000000000000000000000");
    io.coins.mockResolvedValue(
      ["first.nearlytrade.near", "second.nearlytrade.near", memeAsset.contractAddress].map((token) => ({
        token,
        created_at: new Date(Date.now() - 10000).toISOString(),
      })),
    );
    io.profile
      .mockRejectedValueOnce(new SquintUnavailable("unavailable", "Incomplete evidence"))
      .mockRejectedValueOnce(new SquintUnavailable("unavailable", "Incomplete evidence"));
    const { discoveryCursor: _cursor, ...oldState } = state;
    expect(memeStateSchema.parse(oldState).discoveryCursor).toBeNull();
    const first = memeStateSchema.parse((await plan({ ...state, positions: [] })).progress?.strategyState);
    expect(first.positions).toEqual([]);
    expect(first.discoveryCursor).toBe("nep141:second.nearlytrade.near");
    expect(io.report).toHaveBeenCalledTimes(2);
    const next = await plan({ ...first, lastDiscoveryAt: Date.now() - 61000 });
    expect(memeStateSchema.parse(next.progress?.strategyState).positions[0]?.asset).toEqual(memeAsset);
    expect(io.report).toHaveBeenCalledTimes(3);
  });
  it("discovers and rechecks native entries without an Intents registry dependency", async () => {
    await nativeFunds(cashAsset.assetId, "10000000000000000000000000");
    io.registry.mockRejectedValue(new Error("Intents registry unavailable"));
    io.coins.mockResolvedValue([
      { token: memeAsset.contractAddress, created_at: new Date(Date.now() - 10000).toISOString() },
    ]);
    const discovered = await plan({ ...state, positions: [] });
    const native = memeStateSchema.parse(discovered.progress?.strategyState);
    expect(native.positions[0]?.native).toBe(true);
    const proposed = await plan(native);
    expect(proposed.signal).toMatchObject({ scope: "native_near", purpose: "instruction_entry" });
    if (!proposed.signal || !proposed.requestId || proposed.progress?.strategyState.format !== 6) {
      throw new Error("Missing native decision");
    }
    await saveMemeState(context.db, context.agentId, proposed.progress.strategyState);
    const current = await currentAgentStrategy(context.db, "owner", context.agentId, 1);
    const check = await memeSubmissionCheck(
      context.db,
      current,
      {
        ...proposed.signal,
        requestId: proposed.requestId,
        agentId: context.agentId,
        expectedRevision: 1,
      },
      memeQuote(Date.now(), { provider: "rhea", scope: "native_near" }),
    );
    await check(context.db);
    expect((await readAgentTradeAssets(context.db, "owner", context.agentId, 1)).reviewed).toEqual([
      cashAsset,
    ]);
    expect(io.registry).not.toHaveBeenCalled();
    expect(io.sync).not.toHaveBeenCalled();
    expect(io.quote).not.toHaveBeenCalled();
  });
  it("keeps native USD profit exits working without entry cash, risk scans or registry access", async () => {
    await nativeFunds(memeAsset.assetId, "2000000000000000000");
    io.registry.mockRejectedValue(new Error("Intents unavailable"));
    io.report.mockRejectedValue(new Error("Risk service unavailable"));
    io.price.mockImplementation(async () => ({ n: 3n, d: 1n, observedAt: Date.now() }));
    const holding: MemeState = {
      ...state,
      positions: state.positions.map((p) => ({
        ...p,
        native: true as const,
        spot: {
          ...p.spot,
          phase: "holding",
          quantityUnits: "2000000000000000000",
          basisMicroUsd: "2000000",
          runs: 1,
        },
      })),
    };
    const exit = await plan(holding);
    expect(exit.signal).toMatchObject({
      scope: "native_near",
      purpose: "instruction_exit",
      inputUnits: "2000000000000000000",
    });
    expect(io.report).not.toHaveBeenCalled();
    expect(io.registry).not.toHaveBeenCalled();
    expect(io.quote).not.toHaveBeenCalled();
    io.root.mockResolvedValue(null);
    expect((await plan(holding)).reason).toContain("backed-up native trading account");
    expect(io.quote).not.toHaveBeenCalled();
  });
  it("blocks native spending when finalized cash metadata differs from the reviewed binding", async () => {
    await nativeFunds(cashAsset.assetId, "10000000000000000000000000");
    io.metadata.mockImplementation(async (id: string) =>
      id === cashAsset.assetId ? { ...cashAsset, decimals: 18 } : memeAsset,
    );
    const native: MemeState = {
      ...state,
      positions: state.positions.map((p) => ({ ...p, native: true as const })),
    };
    expect((await plan(native)).signal).toBeNull();
    await expect(readAgentTradeAssets(context.db, "owner", context.agentId, 1)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(io.nativeQuote).not.toHaveBeenCalled();
  });
});
