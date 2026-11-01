import { createSecretKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimes, agents, strategyVersions } from "@/server/db/agent-schema";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { checkAgentCycle } from "@/server/engine/check";
import { copyRequestId } from "@/server/engine/copy";
import { assignInventory } from "@/server/positions/attribution";
import { copyEventId, ExplorerFeedPending, publicSwapSchema } from "@/server/research/explorer-contracts";
import { strategySchema } from "@/shared/agents";
import { beginInventorySync, finishInventorySync } from "./inventory";
import fixture from "./oneclick-intent.fixture.json";
import * as records from "./records";
import { executionTestContext } from "./test-context";

vi.mock("server-only", () => ({}));
const transport = vi.hoisted(() => ({
  request: vi.fn(),
  feed: vi.fn(),
  balances: vi.fn(),
  status: vi.fn(),
  tokens: vi.fn(),
}));
vi.mock("@/server/research/explorer", () => ({ publicLeaderFeed: transport.feed }));
vi.mock("@/server/research/intents", () => ({ intentTokens: transport.tokens }));
vi.mock("./oneclick-quote", async (original) => ({
  ...(await original<typeof import("./oneclick-quote")>()),
  oneClickJson: transport.request,
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("./balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));

let context: Awaited<ReturnType<typeof executionTestContext>>;
let activation: string;
const run = "offline-copy-run";
const event = publicSwapSchema.parse({
  originAsset: fixture.request.originAsset,
  destinationAsset: fixture.request.destinationAsset,
  depositAddress: "offline-public-leader-deposit",
  depositMemo: null,
  status: "SUCCESS",
  createdAt: new Date(Date.parse(fixture.request.deadline) - 120_000).toISOString(),
  intentHashes: "offline-leader-intent",
  amountIn: fixture.request.amount,
  amountOut: fixture.quote.quote.amountOut,
  senders: ["leader.near"],
  originChainTxHashes: ["offline-public-origin-transaction"],
  depositType: "ORIGIN_CHAIN",
  recipientType: "INTENTS",
});

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(event.createdAt));
  vi.spyOn(records, "databaseTime").mockImplementation(async () => Date.now());
  context = await executionTestContext({ maxProviderFeeBps: 20 });
  await context.db.update(users).set({ accountId: "intents.near" }).where(eq(users.id, "owner"));
  await context.db.update(delegatedKeys).set(generateAgentKey()).where(eq(delegatedKeys.userId, "owner"));
  const strategy = strategySchema.parse({
    kind: "copy_trading",
    leaderAccountId: "leader.near",
    assets: ["NEAR", "USDC"],
    // User limits use at most six decimal places; the provider fixture preserves twelve trailing places.
    orderSizeUsd: "9.9983",
    maxSignalAgeSeconds: 300,
    maxPriceDeviationBps: 100,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await context.db.update(agents).set({ pack: "copy_trading" }).where(eq(agents.id, context.agentId));
  await context.db
    .update(strategyVersions)
    .set({
      configJson: JSON.stringify(strategy),
      resolvedAssetsJson: JSON.stringify({
        strategyHash: records.executionHash(strategy),
        assets: [
          { symbol: "USDC", assetId: fixture.request.originAsset },
          { symbol: "NEAR", assetId: fixture.request.destinationAsset },
        ],
      }),
    })
    .where(eq(strategyVersions.agentId, context.agentId));
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
    sourceReference: "offline-copy-funding",
    evidenceHash: "c".repeat(64),
  });
  activation = crypto.randomUUID();
  await context.db.insert(agentRuntimes).values({
    agentId: context.agentId,
    userId: "owner",
    activationId: activation,
    inputHash: "a".repeat(64),
    agentRevision: 1,
    strategyVersion: 1,
    workflowRunId: run,
    nextCheckAt: Date.now(),
    state: "active",
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  });
  transport.feed.mockReset().mockImplementation(async () => ({ capturedAt: Date.now(), swaps: [event] }));
  transport.request.mockReset().mockImplementation(async (path: string) => {
    if (path === "/v0/quote") {
      return fixture.quote;
    }
    if (path === "/v0/generate-intent") {
      return fixture.generated;
    }
    if (path === "/v0/submit-intent") {
      return { intentHash: "1".repeat(44), correlationId: "offline-copy" };
    }
    throw new Error("Unexpected offline endpoint");
  });
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
  transport.balances
    .mockReset()
    .mockReturnValue([{ tokenId: fixture.request.originAsset, available: "20000000", source: "private" }]);
  transport.status.mockReset().mockImplementation(() => ({
    quoteResponse: fixture.quote,
    status: "PROCESSING",
    updatedAt: new Date(Date.now()).toISOString(),
    swapDetails: { intentHashes: ["1".repeat(44)] },
  }));
  vi.stubEnv("ONECLICK_JWT", "offline-copy-status");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) =>
      String(url).startsWith("https://1click.chaindefuser.com/v0/status?")
        ? Response.json(transport.status())
        : Response.json({ balances: transport.balances() }),
    ),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await context.postgres.close();
});

describe("Copy Trading through the shared execution ledger", () => {
  it("resumes a deferred shared-feed read at the provider window instead of starving another follower", async () => {
    transport.feed.mockRejectedValueOnce(new ExplorerFeedPending()).mockImplementationOnce(async () => ({
      capturedAt: Date.now(),
      swaps: [],
    }));
    expect(await checkAgentCycle(context.db, activation, run)).toBe(5);
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5001);
    expect(await checkAgentCycle(context.db, activation, run)).toBe(60);
    expect(transport.feed).toHaveBeenCalledTimes(2);
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });

  it("signs once, settles actual fills and deduplicates even after losing its disposable checkpoint", async () => {
    expect(await checkAgentCycle(context.db, activation, run)).toBe(5);
    const [action] = await context.db.select().from(executionActions);
    if (!action || action.inputUnits === null) {
      throw new Error("Missing offline copy action");
    }
    expect(action.status).toBe("submitted");
    expect(action.requestId).toBe(copyRequestId(context.agentId, 1, copyEventId(event)));
    transport.status.mockImplementation(() => ({
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
    }));
    transport.balances.mockReturnValue([
      { tokenId: fixture.request.originAsset, available: "10000000", source: "private" },
      {
        tokenId: fixture.request.destinationAsset,
        available: fixture.quote.quote.amountOut,
        source: "private",
      },
    ]);
    expect(await checkAgentCycle(context.db, activation, run)).toBe(60);
    expect(await context.db.select().from(executionFills)).toHaveLength(1);
    await context.db
      .update(agentRuntimes)
      .set({ strategyStateJson: null })
      .where(eq(agentRuntimes.agentId, context.agentId));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    expect(await checkAgentCycle(context.db, activation, run)).toBe(60);
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(1);
  });

  it("cancels before signing if the fresh follower quote misses the leader-price bound", async () => {
    transport.feed.mockImplementation(async () => ({
      capturedAt: Date.now(),
      swaps: [{ ...event, amountOut: (BigInt(event.amountOut) * 2n).toString() }],
    }));
    expect(await checkAgentCycle(context.db, activation, run)).toBe(60);
    const [action] = await context.db.select().from(executionActions);
    expect(action?.status).toBe("cancelled");
    expect(action?.reservationReleasedAt).not.toBeNull();
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
    expect(transport.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(0);
  });
});
