import {
  inputAssetId,
  manualContext,
  manualIntent,
  observeManual,
  outputAssetId,
  preparedManualOrder,
} from "@tests/server/manual-trading/context";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agents } from "@/server/db/agent-schema";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { agentCapital, capitalAccounts, positionLots } from "@/server/db/position-schema";
import { delegatedKeys } from "@/server/db/schema";
import { executionSubjects } from "@/server/db/subject-schema";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { readProofReport } from "@/server/execution/proof-report";
import { ownedExecution } from "@/server/execution/records";
import {
  confirmManualTrade,
  dismissManualTrade,
  quoteManualTrade,
  readManualPreview,
} from "@/server/manual-trading/service";
import { assignInventory } from "@/server/positions/attribution";
import { DEFAULT_POLICY } from "@/shared/agents";

vi.mock("server-only", () => ({}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline" }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: async () => {} }));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    tokens: [
      {
        assetId: inputAssetId,
        symbol: "USDC",
        blockchain: "near",
        decimals: 6,
        contractAddress: "usdc.test-fixture.near",
      },
      {
        assetId: outputAssetId,
        symbol: "wNEAR",
        blockchain: "near",
        decimals: 24,
        contractAddress: "wrap.near",
      },
    ],
  }),
}));
vi.mock("@/server/execution/intents-quote", () => ({
  prepareIntentsOrder: async (raw: unknown) =>
    preparedManualOrder(z.object({ inputUnits: z.string() }).parse(raw).inputUnits),
}));
let context: Awaited<ReturnType<typeof manualContext>>;
beforeEach(async () => {
  context = await manualContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await context.postgres.close();
});
const confirmation = (p: { id: string; revision: number; bindingHash: string }) => ({
  id: p.id,
  revision: p.revision,
  bindingHash: p.bindingHash,
});
async function quote(amount = "10") {
  return quoteManualTrade(context.db, "owner", {
    requestId: crypto.randomUUID(),
    source: "spot",
    intent: manualIntent(amount),
  });
}

async function allocatedAgent(units: string): Promise<void> {
  const agentId = crypto.randomUUID(),
    now = Date.now();
  await context.db
    .insert(capitalAccounts)
    .values({ userId: "owner", limitMicroUsd: 0n, updatedAt: now })
    .onConflictDoNothing();
  await context.db.insert(agents).values({
    id: agentId,
    userId: "owner",
    name: "Existing agent",
    pack: "spot_trader",
    status: "paused",
    reason: "Test",
    policyJson: JSON.stringify(DEFAULT_POLICY),
    createdAt: now,
    updatedAt: now,
  });
  await context.db
    .insert(agentCapital)
    .values({ userId: "owner", agentId, limitMicroUsd: 100000000n, updatedAt: now });
  await assignInventory(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId,
    scope: "confidential",
    assetId: inputAssetId,
    quantityUnits: units,
    capitalMicroUsd: "0",
    costBasisMicroUsd: null,
    sourceReference: "offline",
    evidenceHash: "c".repeat(64),
  });
}

describe("manual trades in the common ledger", () => {
  it("quotes without creating any agent, strategy or reserved execution", async () => {
    const p = await quote();
    expect(p.status).toBe("quoted");
    expect(await context.db.select().from(agents)).toHaveLength(0);
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    expect((await readProofReport(context.db, "owner")).actions).toEqual([]);
    expect(await context.db.select().from(executionSubjects)).toMatchObject([
      { kind: "manual", agentId: null },
    ]);
  });
  it("consumes an exact confirmation once and preserves its identity across duplicate clicks", async () => {
    const p = await quote(),
      a = await confirmManualTrade(context.db, "owner", confirmation(p)),
      repeated = await confirmManualTrade(context.db, "owner", confirmation(p));
    expect(a.actionId).toBe(repeated.actionId);
    expect(await context.db.select().from(executionActions)).toMatchObject([
      { origin: "manual", status: "reserved", approvedAt: expect.any(Number) },
    ]);
    expect((await readProofReport(context.db, "owner")).actions).toMatchObject([
      { id: a.actionId, origin: "manual", name: null, status: "reserved" },
    ]);
    expect((await readProofReport(context.db, "stranger")).actions).toEqual([]);
    expect(await context.db.select().from(agents)).toHaveLength(0);
    expect(await context.db.select().from(positionLots)).toHaveLength(1);
  });
  it("rejects another owner's read and confirmation, a changed hash and a changed revision", async () => {
    const p = await quote();
    await expect(readManualPreview(context.db, "stranger", p.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(confirmManualTrade(context.db, "stranger", confirmation(p))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      confirmManualTrade(context.db, "owner", { ...confirmation(p), bindingHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      confirmManualTrade(context.db, "owner", { ...confirmation(p), revision: 2 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });
  it("does not spend a real agent's attributed units", async () => {
    await quote();
    await allocatedAgent("95000000");
    const p = await quote();
    await expect(confirmManualTrade(context.db, "owner", confirmation(p))).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });
  it("blocks signing after a withdrawal makes the wallet smaller than all attributed allocations", async () => {
    await allocatedAgent("90000000");
    const preview = await quote(),
      confirmed = await confirmManualTrade(context.db, "owner", confirmation(preview));
    if (!confirmed.actionId) {
      throw new Error("Missing confirmed manual order");
    }
    await observeManual(context.db, "90000000");
    const worker = await claimExecution(context.db, "owner", confirmed.actionId);
    await expect(
      beginSubmission(context.db, "owner", confirmed.actionId, worker.token, {
        payloadHash: "b".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    expect((await ownedExecution(context.db, "owner", confirmed.actionId)).status).toBe("reserved");
  });
  it("rejects expired/dismissed quotes and makes dismissing idempotent", async () => {
    const p = await quote();
    await dismissManualTrade(context.db, "owner", confirmation(p));
    await dismissManualTrade(context.db, "owner", confirmation(p));
    await expect(confirmManualTrade(context.db, "owner", confirmation(p))).rejects.toMatchObject({
      code: "not_ready",
    });
    const expiring = await quote();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiring.expiresAt + 1);
    await expect(confirmManualTrade(context.db, "owner", confirmation(expiring))).rejects.toMatchObject({
      code: "not_ready",
    });
  });
  it("prevents a competing manual order and refuses unconfirmed signing bytes", async () => {
    const p = await quote(),
      second = await quote("20"),
      confirmed = await confirmManualTrade(context.db, "owner", confirmation(p));
    await expect(confirmManualTrade(context.db, "owner", confirmation(second))).rejects.toMatchObject({
      code: "conflict",
    });
    if (!confirmed.actionId) {
      throw new Error("Missing action");
    }
    const worker = await claimExecution(context.db, "owner", confirmed.actionId);
    await expect(
      beginSubmission(context.db, "owner", confirmed.actionId, worker.token, {
        payloadHash: "c".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await ownedExecution(context.db, "owner", confirmed.actionId)).status).toBe("reserved");
  });
  it("checks revocation again immediately before claiming", async () => {
    const p = await quote(),
      confirmed = await confirmManualTrade(context.db, "owner", confirmation(p));
    if (!confirmed.actionId) {
      throw new Error("Missing action");
    }
    await context.db
      .update(delegatedKeys)
      .set({ activatedAt: null, activatedAtBlock: null })
      .where(eq(delegatedKeys.userId, "owner"));
    await expect(claimExecution(context.db, "owner", confirmed.actionId)).rejects.toMatchObject({
      code: "not_ready",
    });
  });
  it("accounts a final fill once, retains holds until refreshed, and can reopen the saved order", async () => {
    const p = await quote(),
      confirmed = await confirmManualTrade(context.db, "owner", confirmation(p));
    if (!confirmed.actionId) {
      throw new Error("Missing action");
    }
    const worker = await claimExecution(context.db, "owner", confirmed.actionId);
    await beginSubmission(context.db, "owner", confirmed.actionId, worker.token, {
      payloadHash: "b".repeat(64),
      providerRequestId: crypto.randomUUID(),
    });
    const fill = {
      providerEventId: "offline-manual-fill",
      inputUnits: "10000000",
      outputUnits: "2000000000000000000000000",
      inputValueMicroUsd: "10000000",
      outputValueMicroUsd: "10000000",
      feeMicroUsd: null,
      occurredAt: Date.now(),
    };
    await recordExecutionFill(context.db, "owner", confirmed.actionId, worker.token, fill);
    await recordExecutionFill(context.db, "owner", confirmed.actionId, worker.token, fill);
    await settleExecution(context.db, "owner", confirmed.actionId, worker.token, {
      providerReceiptId: "offline-terminal",
      refundedInputUnits: "0",
    });
    expect((await ownedExecution(context.db, "owner", confirmed.actionId)).reservationReleasedAt).toBeNull();
    await observeManual(context.db, "90000000", fill.outputUnits);
    expect(
      (await ownedExecution(context.db, "owner", confirmed.actionId)).reservationReleasedAt,
    ).not.toBeNull();
    expect((await readManualPreview(context.db, "owner", p.id)).status).toBe("settled");
    expect(
      await context.db
        .select()
        .from(executionFills)
        .where(and(eq(executionFills.userId, "owner"), eq(executionFills.actionId, confirmed.actionId))),
    ).toHaveLength(1);
  });
});
