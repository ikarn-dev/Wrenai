import { executionTestContext, observeInventory } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { agentCapital, capitalAccounts, positionLots } from "@/server/db/position-schema";
import { allocatePreviewBalance } from "@/server/engine/funding";
import { freshDryQuote } from "@/server/execution/oneclick-quote";
import { createTradePreview } from "@/server/execution/preview";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import type { TradeQuote } from "@/shared/trade-preview";

vi.mock("server-only", () => ({}));
vi.mock("@/server/execution/oneclick-quote", () => ({ freshDryQuote: vi.fn() }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    source: {
      id: "offline-registry",
      label: "Offline registry",
      url: "https://example.test",
      observedAt: Date.now(),
    },
    tokens: [
      { assetId: "nep141:wrap.near", symbol: "NEAR", blockchain: "near", decimals: 24 },
      { assetId: "nep141:usdc.test-fixture.near", symbol: "USDC", blockchain: "near", decimals: 6 },
      { assetId: "nep141:other-output.near", symbol: "BTC", blockchain: "near", decimals: 8 },
      { assetId: "nep141:unrelated.near", symbol: "USDT", blockchain: "near", decimals: 6 },
    ],
  }),
}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
  await observeInventory(context.db, "confidential", "10000000");
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation((db) => observeInventory(db, "confidential", "10000000"));
  vi.mocked(freshDryQuote)
    .mockReset()
    .mockImplementation(
      async (_account, origin, destination, input, slippage) =>
        ({
          provider: "oneclick",
          scope: "confidential",
          inputAssetId: origin,
          outputAssetId: destination,
          inputUnits: input,
          outputUnits: (2n * 10n ** 24n).toString(),
          minOutputUnits: (199n * 10n ** 22n).toString(),
          inputMicroUsd: "5000000",
          outputMicroUsd: "4975000",
          slippageBps: slippage,
          appFeeBps: 0,
          capturedAt: Date.now(),
          expiresAt: Date.now() + 15_000,
          quoteHash: "a".repeat(64),
          recipient: "owner.near",
          refundTo: "owner.near",
          feeNote: "Offline signed-quote adapter fixture.",
        }) satisfies TradeQuote,
    );
});
afterEach(async () => context.postgres.close());
async function input(): Promise<{
  readonly requestId: string;
  readonly previewId: string;
  readonly sharedCapitalUsd: string;
  readonly agentCapitalUsd: string;
}> {
  const preview = await createTradePreview(
    context.db,
    { id: "owner", accountId: "owner.near" },
    {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      expectedRevision: 1,
      inputAssetId: "nep141:usdc.test-fixture.near",
      outputAssetId: "nep141:wrap.near",
      inputUnits: "5000000",
      slippageBps: 50,
    },
    {
      quote: freshDryQuote,
      balances: async () => ({
        scope: "confidential",
        status: "verified",
        observedAt: Date.now(),
        blockHeight: null,
        balances: [
          { assetId: "nep141:usdc.test-fixture.near", units: "10000000" },
          { assetId: "nep141:wrap.near", units: "0" },
          { assetId: "nep141:other-output.near", units: "0" },
          { assetId: "nep141:unrelated.near", units: "0" },
        ],
        note: "Offline complete inventory.",
      }),
    },
  );
  return {
    requestId: crypto.randomUUID(),
    previewId: preview.id,
    sharedCapitalUsd: "100",
    agentCapitalUsd: "100",
  };
}
describe("explicit owner-approved private balance allocation", () => {
  it("assigns only reviewed units, preserves unknown purchase basis and repeats without double allocation", async () => {
    const request = await input();
    await allocatePreviewBalance(context.db, "owner", request);
    await allocatePreviewBalance(context.db, "owner", request);
    expect(
      await unreservedOwnedUnits(
        context.db,
        "owner",
        context.agentId,
        "confidential",
        "nep141:usdc.test-fixture.near",
      ),
    ).toBe(5_000_000n);
    const lots = await context.db.select().from(positionLots);
    expect(lots).toHaveLength(1);
    expect(lots[0]?.remainingBasisMicroUsd).toBeNull();
    expect(lots[0]?.remainingPrincipalMicroUsd).toBe(5_000_000n);
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    expect(synchronizePrivateInventory).toHaveBeenCalledTimes(1);
    await expect(
      allocatePreviewBalance(context.db, "owner", { ...request, agentCapitalUsd: "90" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("checks ownership before provider calls and atomically rolls back ceilings when allocation exceeds them", async () => {
    const request = await input();
    vi.mocked(synchronizePrivateInventory).mockClear();
    await expect(allocatePreviewBalance(context.db, "stranger", request)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(synchronizePrivateInventory).not.toHaveBeenCalled();
    await expect(
      allocatePreviewBalance(context.db, "owner", { ...request, agentCapitalUsd: "4" }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await context.db.select().from(positionLots)).toHaveLength(0);
    expect((await context.db.select().from(capitalAccounts))[0]?.limitMicroUsd).toBe(1_000_000_000n);
    expect((await context.db.select().from(agentCapital))[0]?.limitMicroUsd).toBe(100_000_000n);
  });
});
