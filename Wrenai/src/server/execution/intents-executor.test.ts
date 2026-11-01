import { createSecretKey } from "node:crypto";
import { base58 } from "@scure/base";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimes, agents, strategyVersions, tradingControls } from "@/server/db/agent-schema";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { advanceIntentsAction } from "@/server/engine/action";
import { checkAgentCycle } from "@/server/engine/check";
import { readAgentRuntime } from "@/server/engine/runtime";
import { prepareSwapExecution } from "@/server/execution/intents-order";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import fixture from "@/server/execution/oneclick-intent.fixture.json";
import { claimExecution } from "@/server/execution/ownership";
import * as records from "@/server/execution/records";
import { executionTestContext } from "@/server/execution/test-context";
import { verifyNep413Signature } from "@/server/near/nep413";
import { assignInventory } from "@/server/positions/attribution";
import { strategySchema } from "@/shared/agents";
import { executeIntentsAction } from "./intents-executor";
import { reconcileIntentsAction } from "./intents-reconciliation";

vi.mock("server-only", () => ({}));
const transport = vi.hoisted(() => ({
  request: vi.fn(),
  status: vi.fn(),
  reference: vi.fn(),
  tokens: vi.fn(),
  balances: vi.fn(),
}));
vi.mock("@/server/engine/market-price", () => ({ freshMarketPrice: transport.reference }));
vi.mock("@/server/research/intents", () => ({ intentTokens: transport.tokens }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: transport.request,
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/execution/balance-session", () => ({
  privateBalanceToken: async () => "offline-provider-session",
}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
let publicKey: string;

beforeEach(async () => {
  const now = Date.parse(fixture.request.deadline) - 120_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(records, "databaseTime").mockResolvedValue(now);
  context = await executionTestContext({ maxProviderFeeBps: 20 });
  await context.db.update(users).set({ accountId: "intents.near" }).where(eq(users.id, "owner"));
  const [version] = await context.db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.agentId, context.agentId));
  if (!version?.resolvedAssetsJson) {
    throw new Error("Missing fixture strategy.");
  }
  await context.db
    .update(strategyVersions)
    .set({
      resolvedAssetsJson: version.resolvedAssetsJson.replace(
        "nep141:usdc.test-fixture.near",
        fixture.request.originAsset,
      ),
    })
    .where(eq(strategyVersions.id, version.id));
  const syncToken = await beginInventorySync(context.db, "owner", "confidential");
  await finishInventorySync(context.db, "owner", {
    scope: "confidential",
    syncToken,
    balances: [{ assetId: fixture.request.originAsset, amountUnits: "20000000" }],
  });
  await assignInventory(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "confidential",
    assetId: fixture.request.originAsset,
    quantityUnits: "20000000",
    capitalMicroUsd: "20000000",
    costBasisMicroUsd: "20000000",
    sourceReference: "offline-provider-fixture",
    evidenceHash: "c".repeat(64),
  });
  const generated = generateAgentKey();
  const rawPublic = base58.decode(generated.publicKey.slice("ed25519:".length));
  publicKey = generated.publicKey;
  await context.db.update(delegatedKeys).set(generated).where(eq(delegatedKeys.userId, "owner"));
  transport.request.mockReset().mockImplementation(async (path: string, body: unknown) => {
    if (path === "/v0/quote") {
      return fixture.quote;
    }
    if (path === "/v0/generate-intent") {
      return fixture.generated;
    }
    if (path === "/v0/submit-intent") {
      const { z } = await import("zod");
      const parsed = z
        .object({
          signedData: z.object({
            public_key: z.literal(publicKey),
            signature: z.string(),
            payload: z.object({
              message: z.literal(fixture.generated.intent.payload.message),
              nonce: z.literal(fixture.generated.intent.payload.nonce),
              recipient: z.literal("intents.far"),
            }),
          }),
        })
        .parse(body).signedData;
      expect(
        verifyNep413Signature({
          publicKey: rawPublic,
          signature: base58.decode(parsed.signature.slice("ed25519:".length)),
          payload: {
            message: parsed.payload.message,
            nonce: Buffer.from(parsed.payload.nonce, "base64"),
            recipient: parsed.payload.recipient,
          },
        }),
      ).toBe(true);
      return { intentHash: "1".repeat(44), correlationId: crypto.randomUUID() };
    }
    throw new Error("Unexpected offline provider call");
  });
  vi.stubEnv("ONECLICK_JWT", "offline-status-fixture");
  transport.status.mockReset().mockReturnValue({
    quoteResponse: fixture.quote,
    status: "PROCESSING",
    updatedAt: new Date(now).toISOString(),
    swapDetails: { intentHashes: ["1".repeat(44)] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      if (String(url).startsWith("https://1click.chaindefuser.com/v0/status?")) {
        return Response.json(transport.status());
      }
      return Response.json({ balances: transport.balances() });
    }),
  );
  transport.balances
    .mockReset()
    .mockReturnValue([{ tokenId: fixture.request.originAsset, available: "20000000", source: "private" }]);
  transport.reference.mockReset().mockImplementation(async () => ({
    symbol: "NEAR",
    priceMicroUsd: 4_350_000n,
    marketAt: Date.now(),
    capturedAt: Date.now(),
  }));
  transport.tokens.mockReset().mockImplementation(async () => ({
    tokens: [
      {
        assetId: fixture.request.originAsset,
        symbol: "USDC",
        blockchain: "near",
        decimals: 6,
        contractAddress: fixture.request.originAsset.slice(7),
        price: "0.99983",
        priceUpdatedAt: new Date(Date.now()).toISOString(),
      },
      {
        assetId: fixture.request.destinationAsset,
        symbol: "NEAR",
        blockchain: "near",
        decimals: 24,
        contractAddress: "wrap.near",
        price: "4.35",
        priceUpdatedAt: new Date(Date.now()).toISOString(),
      },
    ],
    source: { observedAt: Date.now() },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await context.postgres.close();
});

async function prepare(): Promise<Awaited<ReturnType<typeof prepareSwapExecution>>> {
  return prepareSwapExecution(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: 1,
    inputAssetId: fixture.request.originAsset,
    outputAssetId: fixture.request.destinationAsset,
    inputUnits: fixture.request.amount,
  });
}

describe("Vercel Intents execution with real quote evidence and offline keys", () => {
  it("verifies the exact signed transfer, commits before submission and never submits twice", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    expect(await executeIntentsAction(context.db, "owner", action.id, worker.token)).toEqual({
      actionId: action.id,
      status: "submitted",
    });
    expect(await executeIntentsAction(context.db, "owner", action.id, worker.token)).toEqual({
      actionId: action.id,
      status: "submitted",
    });
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
    expect((await records.ownedExecution(context.db, "owner", action.id)).payloadHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
  });
  it("never submits after shared authorization is revoked or the global stop is set", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    const [stored] = await context.db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    if (!stored) {
      throw new Error("Missing offline key fixture.");
    }
    await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    await expect(executeIntentsAction(context.db, "owner", action.id, worker.token)).rejects.toMatchObject({
      code: "not_ready",
    });
    await context.db.insert(delegatedKeys).values(stored);
    await context.db
      .insert(tradingControls)
      .values({ userId: "owner", killSwitch: true, updatedAt: Date.now() });
    await expect(executeIntentsAction(context.db, "owner", action.id, worker.token)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(0);
    expect((await records.ownedExecution(context.db, "owner", action.id)).status).toBe("reserved");
  });
  it("keeps a timed-out submission unknown and reserved instead of retrying a signature", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    transport.request.mockRejectedValueOnce(new Error("offline lost acknowledgement"));
    expect(await executeIntentsAction(context.db, "owner", action.id, worker.token)).toEqual({
      actionId: action.id,
      status: "unknown",
    });
    expect(await executeIntentsAction(context.db, "owner", action.id, worker.token)).toEqual({
      actionId: action.id,
      status: "unknown",
    });
    const [stored] = await context.db.select().from(executionActions);
    expect(stored?.reservationReleasedAt).toBeNull();
    expect(stored?.status).toBe("unknown");
  });
  it("keeps processing and ambiguous failures reserved, without creating invented refunds", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    await executeIntentsAction(context.db, "owner", action.id, worker.token);
    for (const status of ["PROCESSING", "FAILED", "PENDING_DEPOSIT"]) {
      transport.status.mockReturnValue({
        quoteResponse: fixture.quote,
        status,
        updatedAt: new Date(Date.now()).toISOString(),
        swapDetails: { intentHashes: ["1".repeat(44)] },
      });
      expect(await reconcileIntentsAction(context.db, "owner", action.id, worker.token)).toBe("pending");
      expect((await records.ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    }
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
  });
  it("records a real final debit after revocation and stop, preserves unknown fees and remains idempotent", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    await executeIntentsAction(context.db, "owner", action.id, worker.token);
    await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    await context.db
      .insert(tradingControls)
      .values({ userId: "owner", killSwitch: true, updatedAt: Date.now() });
    transport.status.mockReturnValue({
      quoteResponse: fixture.quote,
      status: "SUCCESS",
      updatedAt: new Date(Date.now()).toISOString(),
      swapDetails: {
        intentHashes: ["1".repeat(44)],
        depositedAmount: action.inputUnits.toString(),
        amountIn: action.inputUnits.toString(),
        amountOut: fixture.quote.quote.amountOut,
        refundedAmount: "0",
        amountInUsd: fixture.quote.quote.amountInUsd,
      },
    });
    expect(await reconcileIntentsAction(context.db, "owner", action.id, worker.token)).toBe("settled");
    expect(await reconcileIntentsAction(context.db, "owner", action.id, worker.token)).toBe("settled");
    const fills = await context.db.select().from(executionFills);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.inputUnits).toBe(action.inputUnits);
    expect(fills[0]?.feeMicroUsd).toBeNull();
    expect(fills[0]?.outputValueMicroUsd).toBeNull();
    expect(
      (await records.ownedExecution(context.db, "owner", action.id)).reservationReleasedAt,
    ).not.toBeNull();
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
  });
  it("rejects terminal claims with missing amounts or a foreign transfer before changing accounting", async () => {
    const action = await prepare();
    const worker = await claimExecution(context.db, "owner", action.id);
    await executeIntentsAction(context.db, "owner", action.id, worker.token);
    transport.status.mockReturnValue({
      quoteResponse: fixture.quote,
      status: "SUCCESS",
      updatedAt: new Date(Date.now()).toISOString(),
      swapDetails: { intentHashes: ["1".repeat(44)] },
    });
    await expect(reconcileIntentsAction(context.db, "owner", action.id, worker.token)).rejects.toMatchObject({
      code: "not_ready",
    });
    transport.status.mockReturnValue({
      quoteResponse: fixture.quote,
      status: "SUCCESS",
      updatedAt: new Date(Date.now()).toISOString(),
      swapDetails: { intentHashes: ["2".repeat(44)] },
    });
    await expect(reconcileIntentsAction(context.db, "owner", action.id, worker.token)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
    expect((await records.ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });
  it("releases each bounded polling lease, reconciles on the next tick and never signs during manual recovery", async () => {
    const action = await prepare();
    expect(await advanceIntentsAction(context.db, "owner", action.id, "reconcile_only")).toBe(60);
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(0);
    expect(await advanceIntentsAction(context.db, "owner", action.id)).toBe(5);
    expect((await records.ownedExecution(context.db, "owner", action.id)).leaseToken).toBeNull();
    expect(await advanceIntentsAction(context.db, "owner", action.id)).toBe(5);
    expect((await records.ownedExecution(context.db, "owner", action.id)).leaseToken).toBeNull();
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
    const expired = Date.parse(fixture.quote.quote.deadline) + 1;
    vi.spyOn(Date, "now").mockReturnValue(expired);
    vi.spyOn(records, "databaseTime").mockResolvedValue(expired);
    await expect(advanceIntentsAction(context.db, "owner", action.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await records.ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    expect(await advanceIntentsAction(context.db, "owner", action.id, "reconcile_only")).toBe(5);
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
  });
  it("runs a five-second trigger cycle through exact signing, settlement and durable confirmed-position recovery", async () => {
    const strategy = strategySchema.parse({
      kind: "triggers",
      asset: "NEAR",
      quoteAsset: "USDC",
      condition: "buy_above",
      triggerPriceUsd: "4.35",
      orderSizeUsd: "9.9983",
      takeProfitPriceUsd: "5",
      stopLossPriceUsd: "4",
      trailingStopBps: 500,
      maxChaseBps: 100,
      confirmationSeconds: 0,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      rearm: false,
    });
    await context.db.update(agents).set({ pack: "triggers" }).where(eq(agents.id, context.agentId));
    await context.db
      .update(strategyVersions)
      .set({
        configJson: JSON.stringify(strategy),
        resolvedAssetsJson: JSON.stringify({
          strategyHash: records.executionHash(strategy),
          assets: [
            { symbol: "NEAR", assetId: fixture.request.destinationAsset },
            { symbol: "USDC", assetId: fixture.request.originAsset },
          ],
        }),
      })
      .where(eq(strategyVersions.agentId, context.agentId));
    const activation = crypto.randomUUID(),
      run = "offline-trigger-run";
    await context.db.insert(agentRuntimes).values({
      agentId: context.agentId,
      userId: "owner",
      activationId: activation,
      inputHash: "a".repeat(64),
      agentRevision: 1,
      strategyVersion: 1,
      workflowRunId: run,
      segment: 0,
      nextCheckAt: Date.now(),
      failures: 0,
      state: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await checkAgentCycle(context.db, activation, run)).toBe(5);
    const [action] = await context.db.select().from(executionActions);
    if (!action) {
      throw new Error("Missing offline trigger order.");
    }
    expect(action.status).toBe("submitted");
    expect(transport.reference).toHaveBeenCalledTimes(2);
    transport.status.mockReturnValue({
      quoteResponse: fixture.quote,
      status: "SUCCESS",
      updatedAt: new Date(Date.now()).toISOString(),
      swapDetails: {
        intentHashes: ["1".repeat(44)],
        depositedAmount: action.inputUnits?.toString(),
        amountIn: action.inputUnits?.toString(),
        amountOut: fixture.quote.quote.amountOut,
        refundedAmount: "0",
        amountInUsd: fixture.quote.quote.amountInUsd,
      },
    });
    transport.balances.mockReturnValue([
      { tokenId: fixture.request.originAsset, available: "10000000", source: "private" },
      {
        tokenId: fixture.request.destinationAsset,
        available: fixture.quote.quote.amountOut,
        source: "private",
      },
    ]);
    expect(await checkAgentCycle(context.db, activation, run)).toBe(5);
    const later = Date.now() + 6000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    vi.spyOn(records, "databaseTime").mockResolvedValue(later);
    expect(await checkAgentCycle(context.db, activation, run)).toBe(5);
    expect(
      JSON.parse((await readAgentRuntime(context.db, activation))?.strategyStateJson ?? "{}"),
    ).toMatchObject({
      phase: "holding",
      quantityUnits: fixture.quote.quote.amountOut,
      pendingActionId: null,
      lastActionId: action.id,
    });
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
    expect(await context.db.select().from(executionFills)).toHaveLength(1);
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
  });
});
