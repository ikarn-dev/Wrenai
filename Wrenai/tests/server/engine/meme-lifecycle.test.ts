import {
  fillMemeAction,
  memeEvidenceFixture,
  memeQuote,
  memeStateFixture,
  memeTestContext,
  observeMemeInventory,
  reserveMemePlan,
  saveMemeState,
} from "@tests/server/engine/meme-context";
import { startTestSubmission } from "@tests/server/execution/test-context";
import { cashAsset, memeAsset, reportFixture } from "@tests/server/squint/fixtures";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { planMemeCheck } from "@/server/engine/meme-check";
import { applyMemeReceipt } from "@/server/engine/meme-receipt";
import { type MemeState, memeStateSchema } from "@/server/engine/meme-state";
import { hasOpenTriggerPosition } from "@/server/engine/strategy-state";
import { settleExecution } from "@/server/execution/accounting";
import { currentAgentStrategy } from "@/server/execution/asset-review";
import { instructionSubmissionCheck } from "@/server/execution/instruction-reference";
import { reserveExecution } from "@/server/execution/reservations";
import { readSpendingUsage } from "@/server/execution/usage";
import { unreservedOwnedUnits } from "@/server/positions/lots";

const io = vi.hoisted(() => ({
  coins: vi.fn(),
  report: vi.fn(),
  profile: vi.fn(),
  registry: vi.fn(),
  quote: vi.fn(),
  price: vi.fn(),
  sync: vi.fn(),
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
vi.mock("@/server/engine/meme-price", () => ({ memeMarketPrice: io.price }));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));
let context: Awaited<ReturnType<typeof memeTestContext>>;
let state: MemeState;
beforeEach(async () => {
  vi.resetAllMocks();
  context = await memeTestContext();
  state = memeStateFixture(Date.parse(context.instruction.expiresAt) - 3600000);
  io.registry.mockImplementation(async () => ({
    tokens: [cashAsset, memeAsset].map((asset) => ({
      ...asset,
      symbol: asset.tokenSymbol,
      contractAddress: asset.contractAddress,
    })),
    source: { observedAt: Date.now() },
  }));
  io.report.mockImplementation(async () => reportFixture(Date.now()));
  io.profile.mockImplementation(async () =>
    memeEvidenceFixture(Date.parse(context.instruction.expiresAt) - 3600000),
  );
  io.price.mockImplementation(async () => ({ n: 1n, d: 1n, observedAt: Date.now() }));
  io.quote.mockImplementation(async (_owner: string, input: string, output: string, units: string) =>
    input === cashAsset.assetId
      ? memeQuote(Date.now())
      : memeQuote(Date.now(), {
          inputAssetId: input,
          outputAssetId: output,
          inputUnits: units,
          outputUnits: "980000000000000000000000",
          minOutputUnits: "970000000000000000000000",
          inputMicroUsd: "1990000",
          outputMicroUsd: "1960000",
        }),
  );
  io.coins.mockResolvedValue([]);
  io.sync.mockResolvedValue(undefined);
});
afterEach(async () => {
  await context.postgres.close();
  vi.restoreAllMocks();
});
async function plan(raw: MemeState = state): Promise<Awaited<ReturnType<typeof planMemeCheck>>> {
  return planMemeCheck(
    context.db,
    await currentAgentStrategy(context.db, "owner", context.agentId, 1),
    context.instruction,
    JSON.stringify(raw),
  );
}
describe("hunter decisions, shared ledger and receipt recovery", () => {
  it("persists a canonical candidate before reservation and recovers the final receipt once after a crash", async () => {
    const proposed = await plan();
    expect(proposed.signal).toMatchObject({
      inputAssetId: cashAsset.assetId,
      outputAssetId: memeAsset.assetId,
      purpose: "instruction_entry",
    });
    const action = await reserveMemePlan(context, proposed);
    await fillMemeAction(context, action.id, "1000000000000000000000000", "2000000000000000000", "2000000");
    const pending = memeStateSchema.parse(proposed.progress?.strategyState);
    await expect(
      applyMemeReceipt(context.db, "owner", context.agentId, 1, context.instruction, pending),
    ).rejects.toThrow("Reconcile");
    await observeMemeInventory(context.db, "9000000000000000000000000", "2000000000000000000");
    const recovered = await applyMemeReceipt(
      context.db,
      "owner",
      context.agentId,
      1,
      context.instruction,
      pending,
    );
    expect(recovered?.positions[0]?.spot).toMatchObject({
      phase: "holding",
      quantityUnits: "2000000000000000000",
      runs: 1,
    });
    expect(recovered?.seen).toEqual([memeAsset.assetId]);
    if (!recovered) {
      throw new Error("Missing recovered state");
    }
    expect(
      await applyMemeReceipt(context.db, "owner", context.agentId, 1, context.instruction, recovered),
    ).toBeNull();
    expect(
      await unreservedOwnedUnits(context.db, "owner", context.agentId, "confidential", memeAsset.assetId),
    ).toBe(2000000000000000000n);
    expect(hasOpenTriggerPosition(JSON.stringify(recovered))).toBe(true);
  });
  it("rechecks entry evidence before signing and detects a lifecycle change inside the owner-lock callback", async () => {
    const proposed = await plan();
    if (!proposed.signal || !proposed.requestId || proposed.progress?.strategyState.format !== 6) {
      throw new Error("Missing signal");
    }
    await saveMemeState(context.db, context.agentId, proposed.progress.strategyState);
    const current = await currentAgentStrategy(context.db, "owner", context.agentId, 1);
    const signal = {
      ...proposed.signal,
      requestId: proposed.requestId,
      agentId: context.agentId,
      expectedRevision: 1,
    };
    const verify = await instructionSubmissionCheck(context.db, current, signal, memeQuote(Date.now()));
    expect(io.profile.mock.calls.length).toBeGreaterThan(1);
    await verify?.(context.db);
    await saveMemeState(context.db, context.agentId, {
      ...proposed.progress.strategyState,
      lastDiscoveryAt: Date.now(),
    });
    await expect(verify?.(context.db)).rejects.toMatchObject({ code: "not_ready" });
    io.report.mockRejectedValue(new Error("risk service unavailable"));
    await expect(
      instructionSubmissionCheck(context.db, current, signal, memeQuote(Date.now())),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
  it("accounts only actual partial fills and releases the exact refunded input after final inventory", async () => {
    const proposed = await plan(),
      action = await reserveMemePlan(context, proposed);
    await fillMemeAction(
      context,
      action.id,
      "500000000000000000000000",
      "1000000000000000000",
      "1000000",
      "500000000000000000000000",
    );
    await observeMemeInventory(context.db, "9500000000000000000000000", "1000000000000000000");
    const settled = await applyMemeReceipt(
      context.db,
      "owner",
      context.agentId,
      1,
      context.instruction,
      memeStateSchema.parse(proposed.progress?.strategyState),
    );
    expect(settled?.positions[0]?.spot.quantityUnits).toBe("1000000000000000000");
    expect(
      await unreservedOwnedUnits(context.db, "owner", context.agentId, "confidential", cashAsset.assetId),
    ).toBe(9500000000000000000000000n);
  });
  it("does not fabricate a position or immediately rebuy a completely refunded attempt", async () => {
    const proposed = await plan(),
      action = await reserveMemePlan(context, proposed);
    const submission = await startTestSubmission(context.db, action.id);
    await settleExecution(context.db, "owner", action.id, submission.token, {
      providerReceiptId: `refund:${action.id}`,
      refundedInputUnits: context.instruction.amountUnits,
    });
    await observeMemeInventory(context.db, "10000000000000000000000000", "0");
    const refunded = await applyMemeReceipt(
      context.db,
      "owner",
      context.agentId,
      1,
      context.instruction,
      memeStateSchema.parse(proposed.progress?.strategyState),
    );
    expect(refunded?.positions).toEqual([]);
    expect(refunded?.seen).toContain(memeAsset.assetId);
    expect((await plan(memeStateSchema.parse(refunded))).signal).toBeNull();
  });
  it("rejects substituted contracts, invented reduce-only entries and size-specific exit failures", async () => {
    const proposed = await plan();
    if (proposed.progress?.strategyState.format !== 6) {
      throw new Error("Missing candidate state");
    }
    await saveMemeState(context.db, context.agentId, proposed.progress.strategyState);
    const base = {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      agentRevision: 1,
      strategyVersion: 1,
      riskPolicyRevision: 0,
      budgetMode: "per_agent" as const,
      scope: "confidential" as const,
      inputAssetId: cashAsset.assetId,
      outputAssetId: "nep141:substitute.near",
      inputUnits: context.instruction.amountUnits,
      minOutputUnits: "1",
      notionalMicroUsd: "5000000",
      slippageBps: 50,
      quoteId: "offline",
      quoteHash: "a".repeat(64),
      expiresAt: Date.now() + 15000,
    };
    await expect(reserveExecution(context.db, "owner", base)).rejects.toMatchObject({ code: "limit" });
    await expect(
      reserveExecution(context.db, "owner", { ...base, outputAssetId: memeAsset.assetId, reduceOnly: true }),
    ).rejects.toMatchObject({ code: "limit" });
    io.quote.mockImplementation(async (_owner: string, input: string) =>
      memeQuote(
        Date.now(),
        input === cashAsset.assetId
          ? {}
          : { inputAssetId: memeAsset.assetId, outputAssetId: cashAsset.assetId, minOutputUnits: "1" },
      ),
    );
    expect((await plan()).signal).toBeNull();
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });
  it("keeps protective exits independent of risk-service outages and entry/day caps", async () => {
    const entry = await plan(),
      action = await reserveMemePlan(context, entry);
    await fillMemeAction(context, action.id, "1000000000000000000000000", "2000000000000000000", "2000000");
    await observeMemeInventory(context.db, "9000000000000000000000000", "2000000000000000000");
    const holding = await applyMemeReceipt(
      context.db,
      "owner",
      context.agentId,
      1,
      context.instruction,
      memeStateSchema.parse(entry.progress?.strategyState),
    );
    if (!holding) {
      throw new Error("Missing confirmed holding");
    }
    const current = await currentAgentStrategy(context.db, "owner", context.agentId, 1);
    const { policySchema } = await import("@/shared/agents");
    await context.db
      .update(agents)
      .set({
        policyJson: JSON.stringify({
          ...policySchema.parse(JSON.parse(current.agent.policyJson)),
          maxTradeUsd: "0.01",
          dailyCapUsd: "0.01",
        }),
      })
      .where(eq(agents.id, context.agentId));
    io.report.mockRejectedValue(new Error("risk-service outage"));
    io.profile.mockClear();
    io.price.mockImplementation(async () => ({ n: 3n, d: 1n, observedAt: Date.now() }));
    io.quote.mockImplementation(async () =>
      memeQuote(Date.now(), {
        inputAssetId: memeAsset.assetId,
        outputAssetId: cashAsset.assetId,
        inputUnits: "2000000000000000000",
        outputUnits: "3000000000000000000000000",
        minOutputUnits: "2990000000000000000000000",
        inputMicroUsd: "6000000",
        outputMicroUsd: "6000000",
      }),
    );
    const exit = await plan(holding);
    expect(exit.signal?.purpose).toBe("instruction_exit");
    expect(io.profile).not.toHaveBeenCalled();
    const reserved = await reserveMemePlan(context, exit, true);
    expect(JSON.parse(reserved.planJson).reduceOnly).toBe(true);
    expect(
      (await readSpendingUsage(context.db, "owner", context.agentId, Date.now())).agentPendingMicroUsd,
    ).toBe(0n);
  });
  it("skips unsupported latest listings without spending full-report quota", async () => {
    const empty = { ...state, positions: [] };
    io.coins.mockResolvedValue([
      { token: "new.nearlytrade.near", created_at: new Date(Date.now() - 10000).toISOString() },
    ]);
    io.report.mockClear();
    const result = await plan(empty);
    expect(result.signal).toBeNull();
    expect(result.reason).toContain("none has a supported trading route");
    expect(io.report).not.toHaveBeenCalled();
  });
});
