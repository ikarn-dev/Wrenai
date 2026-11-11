import { beforeEach, describe, expect, it, vi } from "vitest";
import { nearAsPoolToken, routeInstruction, withoutRoute } from "@/server/ai/strategy-route";
import type { IntentToken } from "@/server/research/intents";
import { agentInstructionSchema, publicRoutePool, usesPublicRoute } from "@/shared/agent-instructions";
import { WALLET_SWAP_USDC } from "@/shared/wallet-swap";

const pools = vi.hoisted(() => ({ findDclPool: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/execution/rhea/pools", () => ({
  findDclPool: pools.findDclPool,
  namedContracts: () => [],
  publicRouteTokens: async () => [],
}));

const TOKEN = "nep141:token.tkn.near";
const POOL = "token.tkn.near|wrap.near|2000";
const registry: readonly IntentToken[] = [
  { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
  { assetId: WALLET_SWAP_USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: "nep141:usdt.tether-token.near", symbol: "USDT", blockchain: "near", decimals: 6 },
];
const candidates: readonly IntentToken[] = [
  ...registry,
  { assetId: TOKEN, symbol: "TKN", blockchain: "near", decimals: 18 },
];
function spot(fields: Record<string, unknown> = {}) {
  return agentInstructionSchema.parse({
    format: 2,
    kind: "spot_trader",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    payAssetId: "nep141:wrap.near",
    buyAssetId: TOKEN,
    priceUnit: "quote_token",
    amountUnits: "1000000000000000000000000",
    side: "buy",
    entry: { type: "market" },
    exits: { takeProfitPrice: null, stopLossPrice: null, trailingStopBps: null },
    ...fields,
  });
}

describe("route chosen at review", () => {
  beforeEach(() => {
    pools.findDclPool.mockReset();
    pools.findDclPool.mockResolvedValue(POOL);
  });

  it("keeps a pair of private-route tokens private and never looks for a pool", async () => {
    const instruction = spot({ buyAssetId: WALLET_SWAP_USDC });
    const routed = await routeInstruction(instruction, registry, candidates);
    expect(usesPublicRoute(routed)).toBe(false);
    expect(pools.findDclPool).not.toHaveBeenCalled();
  });

  it("pins a token outside the private route to its RHEA pool, with exits", async () => {
    const routed = await routeInstruction(
      spot({ exits: { takeProfitPrice: "2", stopLossPrice: "0.5", trailingStopBps: null } }),
      registry,
      candidates,
    );
    expect(publicRoutePool(routed)).toBe(POOL);
    expect(pools.findDclPool).toHaveBeenCalledWith("wrap.near", "token.tkn.near");
  });

  it("trades a native NEAR leg as wNEAR, the form RHEA pools and 1Click trade", () => {
    expect(nearAsPoolToken({ kind: "spot_trader", payAssetId: "native:near", buyAssetId: TOKEN })).toEqual({
      kind: "spot_trader",
      payAssetId: "nep141:wrap.near",
      buyAssetId: TOKEN,
    });
  });

  it("refuses pairs it cannot value, price or find a pool for, and non-spot agents", async () => {
    await expect(
      routeInstruction(spot({ payAssetId: "nep141:usdt.tether-token.near" }), registry, candidates),
    ).rejects.toThrow("Pair this token with NEAR or USDC");
    await expect(
      routeInstruction(
        spot({ priceUnit: "usd", entry: { type: "price", direction: "below", price: "1" } }),
        registry,
        candidates,
      ),
    ).rejects.toThrow("TKN has no USD price feed");
    pools.findDclPool.mockResolvedValue(null);
    await expect(routeInstruction(spot(), registry, candidates)).rejects.toThrow("RHEA has no pool");
    const payment = agentInstructionSchema.parse({
      format: 2,
      kind: "private_payments",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      assetId: TOKEN,
      amountUnits: "1",
      recipient: "friend.near",
      destination: "confidential",
      executeAfter: new Date().toISOString(),
    });
    await expect(routeInstruction(payment, registry, candidates)).rejects.toThrow("has no private route");
  });

  it("ignores a route the model proposes and rejects a pool for a different pair", () => {
    expect(withoutRoute({ kind: "dca", route: { venue: "rhea_dcl", poolId: POOL } })).toEqual({
      kind: "dca",
    });
    expect(
      agentInstructionSchema.safeParse({
        ...spot(),
        route: { venue: "rhea_dcl", poolId: "other.near|wrap.near|100" },
      }).success,
    ).toBe(false);
  });
});
