import { executionTestContext, fundTestAgent, observeInventory } from "@tests/server/execution/test-context";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import { tradePreviews } from "@/server/db/preview-schema";
import { readAgentTradeAssets, reviewAgentTradeAssets } from "@/server/execution/asset-review";
import { createTradePreview, latestTradePreview } from "@/server/execution/preview";
import type { IntentToken } from "@/server/research/intents";
import type { TradeBalance, TradePreviewInput, TradeQuote } from "@/shared/trade-preview";

vi.mock("server-only", () => ({}));
const tokens: readonly IntentToken[] = [
  { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
  { assetId: "nep141:usdc.test-fixture.near", symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: "nep141:other-output.near", symbol: "BTC", blockchain: "near", decimals: 8 },
  { assetId: "nep141:unrelated.near", symbol: "USDT", blockchain: "near", decimals: 6 },
];
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({ tokens, source: { observedAt: Date.now() } }),
}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
let input: TradePreviewInput;
const user = { id: "owner", accountId: "owner.near" };
function balance(): TradeBalance {
  return {
    scope: "confidential",
    status: "verified",
    observedAt: Date.now(),
    blockHeight: null,
    balances: tokens.map((token) => ({
      assetId: token.assetId,
      units: token.symbol === "USDC" ? "100000000" : "0",
    })),
    note: "Offline provider fixture.",
  };
}
function quote(): TradeQuote {
  return {
    provider: "oneclick",
    scope: "confidential",
    inputAssetId: input.inputAssetId,
    outputAssetId: input.outputAssetId,
    inputUnits: input.inputUnits,
    outputUnits: "2000000000000000000000000",
    minOutputUnits: "1990000000000000000000000",
    inputMicroUsd: "10000000",
    outputMicroUsd: "9950000",
    slippageBps: 50,
    capturedAt: Date.now(),
    expiresAt: Date.now() + 15_000,
    appFeeBps: 0,
    quoteHash: "a".repeat(64),
    recipient: user.accountId,
    refundTo: user.accountId,
    feeNote: "Offline signed-quote adapter fixture.",
  };
}
const providers = { balances: async () => balance(), quote: async () => quote() };
beforeEach(async () => {
  context = await executionTestContext();
  await observeInventory(context.db, "confidential", "100000000");
  await fundTestAgent(context.db, context.agentId, "100000000", "100000000");
  input = {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: 1,
    inputAssetId: "nep141:usdc.test-fixture.near",
    outputAssetId: "nep141:wrap.near",
    inputUnits: "10000000",
    slippageBps: 50,
  };
});
afterEach(async () => context.postgres.close());

describe("trade previews", () => {
  it("saves exact owner-scoped Guard evidence without reserving or submitting funds", async () => {
    const preview = await createTradePreview(context.db, user, input, providers);
    expect(preview.decision).toBe("allowed");
    expect(preview.executionEnabled).toBe(false);
    expect(preview.input.decimals).toBe(6);
    expect(preview.quote?.minOutputUnits).toBe("1990000000000000000000000");
    expect(await latestTradePreview(context.db, user.id, context.agentId, 1)).toEqual(preview);
    expect((await context.postgres.query("SELECT id FROM execution_actions")).rows).toHaveLength(0);
    expect((await createTradePreview(context.db, user, input, providers)).id).toBe(preview.id);
    expect(await context.db.select().from(tradePreviews)).toHaveLength(1);
    await expect(
      createTradePreview(context.db, user, { ...input, inputUnits: "20000000" }, providers),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("blocks unavailable balances, stale quotes and missing valuations instead of inventing availability", async () => {
    const preview = await createTradePreview(context.db, user, input, {
      balances: async () => ({ ...balance(), status: "unavailable", balances: [] }),
      quote: async () => ({ ...quote(), expiresAt: Date.now() - 1, inputMicroUsd: null }),
    });
    expect(preview.decision).toBe("blocked");
    expect(preview.checks.filter((check) => check.status === "blocked").map((check) => check.id)).toEqual(
      expect.arrayContaining(["quote", "balance", "valuation"]),
    );
    expect(preview.balance.balances).toHaveLength(0);
  });
  it("checks current paused state and refuses cross-owner access", async () => {
    await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
    const preview = await createTradePreview(context.db, user, input, providers);
    expect(preview.decision).toBe("blocked");
    expect(preview.checks.some((check) => check.id === "agent_status" && check.status === "blocked")).toBe(
      true,
    );
    await expect(
      createTradePreview(context.db, { id: "stranger", accountId: "stranger.near" }, input, providers),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(latestTradePreview(context.db, "stranger", context.agentId, 1)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("fences strategy edits during provider I/O and protects stored previews from SQL mutations", async () => {
    const preview = await createTradePreview(context.db, user, input, providers);
    await expect(
      context.db.update(tradePreviews).set({ snapshotJson: "{}" }).where(eq(tradePreviews.id, preview.id)),
    ).rejects.toThrow();
    await expect(context.db.delete(tradePreviews).where(eq(tradePreviews.id, preview.id))).rejects.toThrow();
    await expect(context.db.execute(sql`TRUNCATE trade_previews`)).rejects.toThrow();
    await expect(
      createTradePreview(
        context.db,
        user,
        { ...input, requestId: crypto.randomUUID() },
        {
          ...providers,
          quote: async () => {
            await context.db.update(agents).set({ revision: 2 }).where(eq(agents.id, context.agentId));
            return quote();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("exact asset review", () => {
  it("requires explicit IDs, rejects symbol mismatches, and prevents silently replacing reviewed assets", async () => {
    await context.db
      .update(strategyVersions)
      .set({ resolvedAssetsJson: null })
      .where(eq(strategyVersions.agentId, context.agentId));
    const available = await readAgentTradeAssets(context.db, user.id, context.agentId, 1);
    expect(available.reviewed).toHaveLength(0);
    expect(available.choices[0]?.candidates[0]?.assetId).toBe("nep141:wrap.near");
    const assets = available.choices.map((choice) => ({
      symbol: choice.symbol,
      assetId: choice.candidates[0]?.assetId ?? "",
    }));
    await expect(
      reviewAgentTradeAssets(context.db, user.id, {
        agentId: context.agentId,
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
        assets: assets.map((asset) => ({ ...asset, assetId: "nep141:wrap.near" })),
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    const input = { agentId: context.agentId, expectedRevision: 1, requestId: crypto.randomUUID(), assets };
    const reviewed = await reviewAgentTradeAssets(context.db, user.id, input);
    expect(reviewed).toHaveLength(4);
    expect(await reviewAgentTradeAssets(context.db, user.id, input)).toEqual(reviewed);
    expect((await readAgentTradeAssets(context.db, user.id, context.agentId, 1)).reviewed).toEqual(reviewed);
  });
});
