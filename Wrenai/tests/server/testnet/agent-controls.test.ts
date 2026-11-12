import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/testnet/provider", async () => {
  const original =
    await vi.importActual<typeof import("@/server/testnet/provider")>("@/server/testnet/provider");
  return { ...original, testnetQuote: vi.fn() };
});

import { claimTestnetAgent, deleteTestnetAgent, restartTestnetAgent } from "@/server/testnet/agent-controls";
import { openReview, sealAgentRecord, sealReview } from "@/server/testnet/agent-record";
import { tickTestnetAgent } from "@/server/testnet/agent-tick";
import { stopTestnetAgent } from "@/server/testnet/agents";
import { TestnetError } from "@/server/testnet/config";
import { changeBalance, ownedBalance, poolTransaction } from "@/server/testnet/pool";
import { testnetQuote } from "@/server/testnet/provider";
import { tnAgents } from "@/server/testnet/schema";
import type { TestnetRule } from "@/shared/testnet";
import { testnetContext, USDC, USDT } from "./context";

let c: Awaited<ReturnType<typeof testnetContext>>;
beforeEach(async () => {
  c = await testnetContext();
});
afterEach(async () => {
  await c.postgres.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function rule(overrides: Partial<TestnetRule> = {}): TestnetRule {
  return {
    name: "DCA",
    kind: "dca",
    assetId: USDC,
    outputAssetId: USDT,
    recipient: null,
    amount: "1",
    budget: "2",
    intervalSeconds: 60,
    costBasis: null,
    thresholdBps: 500,
    expiresAt: c.owner.expiresAt,
    ...overrides,
  };
}

async function agent(state: "running" | "stopped", strategy: TestnetRule, units: bigint, held = 0n) {
  const id = randomUUID();
  await c.db.insert(tnAgents).values({
    id,
    ownerId: c.owner.id,
    requestId: randomUUID(),
    name: strategy.name,
    kind: strategy.kind,
    state,
    sealedRule: sealAgentRecord(c.owner.id, id, strategy, null),
    nextAt: Date.now(),
    expiresAt: strategy.expiresAt,
    createdAt: Date.now(),
  });
  await poolTransaction(c.db, (tx) => changeBalance(tx, c.owner.id, USDC, units, held, id));
  return id;
}

async function row(id: string) {
  const [found] = await c.db.select().from(tnAgents).where(eq(tnAgents.id, id));
  return found;
}

describe("testnet agent controls", () => {
  it("keeps a stopped or deleted agent's funds for Claims; a claim returns only free units", async () => {
    const id = await agent("running", rule(), 2000000n, 1000000n);
    await stopTestnetAgent(c.db, c.owner.id, id);
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("0");
    await deleteTestnetAgent(c.db, c.owner.id, id);
    await stopTestnetAgent(c.db, c.owner.id, id);
    expect((await row(id))?.state).toBe("deleted");
    await claimTestnetAgent(c.db, c.owner.id, id);
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("1000000");
    expect(await ownedBalance(c.db, c.owner.id, USDC, id)).toMatchObject({
      units: "1000000",
      held: "1000000",
    });
    await expect(claimTestnetAgent(c.db, c.owner.id, id)).rejects.toThrow("Nothing to claim");
    await expect(claimTestnetAgent(c.db, c.stranger.id, id)).rejects.toThrow("not available");
  });
  it("stops a running agent before claiming its funds", async () => {
    const id = await agent("running", rule(), 2000000n);
    await claimTestnetAgent(c.db, c.owner.id, id);
    expect((await row(id))?.state).toBe("stopped");
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("2000000");
  });
  it("restarts a claimed agent by reserving its budget again, and only from stopped", async () => {
    const payments = rule({ name: "Pay", kind: "payments", outputAssetId: null, recipient: "bob.testnet" });
    const id = await agent("stopped", payments, 0n);
    await expect(restartTestnetAgent(c.db, c.owner, id)).rejects.toThrow("must be free");
    await poolTransaction(c.db, (tx) => changeBalance(tx, c.owner.id, USDC, 3000000n, 0n));
    await restartTestnetAgent(c.db, c.owner, id);
    expect(await row(id)).toMatchObject({ state: "running", slot: 1, reason: null });
    expect((await ownedBalance(c.db, c.owner.id, USDC, id)).units).toBe("2000000");
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("1000000");
    await expect(restartTestnetAgent(c.db, c.owner, id)).rejects.toThrow("already running");
    await deleteTestnetAgent(c.db, c.owner.id, id);
    await expect(restartTestnetAgent(c.db, c.owner, id)).rejects.toThrow("deleted");
  });
  it("keeps running through a provider outage and retries within seconds", async () => {
    const id = await agent("running", rule({ kind: "dip" }), 2000000n);
    vi.mocked(testnetQuote).mockRejectedValue(
      new TestnetError("unavailable", "Live testnet pricing is unavailable. New orders are paused."),
    );
    expect(await tickTestnetAgent(c.db, id)).toBe(10_000);
    expect(await row(id)).toMatchObject({ state: "running", reason: expect.stringContaining("pricing") });
  });
  it("waits exactly until the next slot, and ends when its end time passes", async () => {
    const id = await agent("running", rule(), 2000000n);
    await c.db
      .update(tnAgents)
      .set({ nextAt: Date.now() + 42_000 })
      .where(eq(tnAgents.id, id));
    const wait = await tickTestnetAgent(c.db, id);
    expect(wait).toBeGreaterThan(41_000);
    expect(wait).toBeLessThanOrEqual(42_000);
    await c.db
      .update(tnAgents)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(tnAgents.id, id));
    expect(await tickTestnetAgent(c.db, id)).toBeNull();
    expect(await row(id)).toMatchObject({ state: "stopped", reason: expect.stringContaining("end time") });
  });
  it("stops with the reason when a cap blocks the order", async () => {
    const id = await agent("running", rule({ kind: "dip" }), 2000000n);
    vi.mocked(testnetQuote).mockRejectedValue(new TestnetError("limit", "The per-action cap is reached."));
    await tickTestnetAgent(c.db, id);
    expect(await row(id)).toMatchObject({
      state: "stopped",
      reason: "Stopped: The per-action cap is reached.",
    });
  });
  it("records a review's verification only for the exact reviewed rule", () => {
    const reviewed = rule(),
      hash = "a".repeat(64);
    const token = sealReview(c.owner.id, reviewed, {
      model: "Qwen/Qwen3.8-27B",
      completionId: "completion",
      signatureKind: "provider_tee",
      verifiedAt: 1,
      requestHash: hash,
      responseHash: hash,
      evidenceHash: hash,
      evidenceJson: "{}",
    });
    expect(openReview(c.owner.id, reviewed, token)?.completionId).toBe("completion");
    expect(openReview(c.owner.id, { ...reviewed, budget: "3" }, token)).toBeNull();
    expect(openReview(c.stranger.id, reviewed, token)).toBeNull();
    expect(openReview(c.owner.id, reviewed, undefined)).toBeNull();
  });
});
