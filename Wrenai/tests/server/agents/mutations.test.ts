import { testDatabase } from "@tests/server/db/test-database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareStrategyDraft } from "@/server/agents/drafts";
import { commandAgent, readAgent, saveAgent, setGlobalStop } from "@/server/agents/mutations";
import { globalStopRevision, killSwitchEngaged, listAgents, stopUserAgents } from "@/server/agents/records";
import * as tables from "@/server/db/agent-schema";
import { delegatedKeys } from "@/server/db/schema";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { setAgentCapitalLimit, setUserCapitalLimit } from "@/server/positions/capital-limits";
import { DEFAULT_POLICY, type Strategy } from "@/shared/agents";

vi.mock("server-only", () => ({}));
const inference = vi.hoisted(() => ({ parse: vi.fn(), registration: vi.fn() }));
vi.mock("@/server/ai/strategy-parser", () => ({ parseAttestedStrategy: inference.parse }));
vi.mock("@/server/db/client", () => ({ database: () => context.db }));
vi.mock("@/server/intents/verifier", () => ({ readKeyRegistration: inference.registration }));

const owner = "owner";
const stranger = "stranger";
const strategy: Strategy = {
  kind: "rebalancer",
  targets: [
    { symbol: "NEAR", weightBps: 5000 },
    { symbol: "USDC", weightBps: 5000 },
  ],
  driftBps: 500,
  intervalSeconds: 300,
};
let context: Awaited<ReturnType<typeof testDatabase>>;
function receipt() {
  return {
    model: "Qwen/Qwen3.8-27B",
    completionId: "test-completion",
    signatureKind: "provider_tee",
    verifiedAt: Date.now(),
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    evidenceHash: "c".repeat(64),
    evidenceJson: "{}",
  };
}
async function draft(userId = owner): Promise<string> {
  const id = crypto.randomUUID();
  await context.db.insert(tables.strategyDrafts).values({
    id,
    userId,
    requestId: crypto.randomUUID(),
    pack: "rebalancer",
    strategyText: "Keep equal NEAR and USDC allocations.",
    configJson: JSON.stringify(strategy),
    attestationJson: JSON.stringify(receipt()),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  return id;
}
async function create(userId = owner): Promise<string> {
  return saveAgent(context.db, userId, {
    requestId: crypto.randomUUID(),
    draftId: await draft(userId),
    policy: DEFAULT_POLICY,
    agentId: null,
    expectedRevision: null,
  });
}
async function command(
  agentId: string,
  action: "pause" | "resume" | "stop" | "clone" | "delete",
  userId = owner,
): Promise<string> {
  return commandAgent(context.db, userId, {
    requestId: crypto.randomUUID(),
    agentId,
    expectedRevision: (await readAgent(context.db, userId, agentId)).revision,
    command: action,
  });
}

describe("Postgres-backed agent management", () => {
  beforeEach(async () => {
    context = await testDatabase();
    inference.parse.mockReset();
    inference.parse.mockResolvedValue({ strategy, receipt: receipt() });
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("creates paused agents with distinct generated names, policies, versions and audits", async () => {
    const id = await create();
    const agent = await readAgent(context.db, owner, id);
    expect(agent).toMatchObject({ status: "paused", strategy, policy: DEFAULT_POLICY, version: 1 });
    expect(agent.name).toMatch(/^[A-Z][\w -]+ [A-Z][\w -]+$/);
    expect(agent.name).not.toBe("Jarvis");
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(1);
    expect((await readAgent(context.db, owner, await create())).name).not.toBe(agent.name);
  });

  it("rejects saved retired watchlist drafts and blocks old agent resume/clone while permitting deletion", async () => {
    const draftId = await draft();
    await context.db
      .update(tables.strategyDrafts)
      .set({ pack: "whale_tracker" })
      .where(eq(tables.strategyDrafts.id, draftId));
    await expect(
      saveAgent(context.db, owner, {
        requestId: crypto.randomUUID(),
        draftId,
        policy: DEFAULT_POLICY,
        agentId: null,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    const id = await create();
    await context.db.update(tables.agents).set({ pack: "whale_tracker" }).where(eq(tables.agents.id, id));
    await expect(command(id, "resume")).rejects.toMatchObject({ code: "not_ready" });
    await expect(command(id, "clone")).rejects.toMatchObject({ code: "not_ready" });
    await command(id, "delete");
    expect(await listAgents(context.db, owner)).toEqual([]);
  });

  it("recovers creates after lost responses and rejects request-ID payload changes", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      draftId: await draft(),
      policy: DEFAULT_POLICY,
      agentId: null,
      expectedRevision: null,
    };
    const id = await saveAgent(context.db, owner, input);
    expect(await saveAgent(context.db, owner, input)).toBe(id);
    expect(await listAgents(context.db, owner)).toHaveLength(1);
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(1);
    await expect(
      saveAgent(context.db, owner, { ...input, policy: { ...DEFAULT_POLICY, budgetUsd: "200" } }),
    ).rejects.toThrow("already used");
  });

  it("serializes simultaneous saves of the same request without duplicate agents", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      draftId: await draft(),
      policy: DEFAULT_POLICY,
      agentId: null,
      expectedRevision: null,
    };
    const [a, b] = await Promise.all([
      saveAgent(context.db, owner, input),
      saveAgent(context.db, owner, input),
    ]);
    expect(a).toBe(b);
    expect(await listAgents(context.db, owner)).toHaveLength(1);
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(1);
  });

  it("rejects stolen, expired and consumed drafts", async () => {
    const id = await draft();
    const input = {
      requestId: crypto.randomUUID(),
      draftId: id,
      policy: DEFAULT_POLICY,
      agentId: null,
      expectedRevision: null,
    };
    await expect(saveAgent(context.db, stranger, input)).rejects.toThrow("expired or was already saved");
    await context.db
      .update(tables.strategyDrafts)
      .set({ expiresAt: 0 })
      .where(eq(tables.strategyDrafts.id, id));
    await expect(saveAgent(context.db, owner, input)).rejects.toThrow("expired");
    const fresh = { ...input, draftId: await draft(), requestId: crypto.randomUUID() };
    await saveAgent(context.db, owner, fresh);
    await expect(saveAgent(context.db, owner, { ...fresh, requestId: crypto.randomUUID() })).rejects.toThrow(
      "already saved",
    );
    expect(await listAgents(context.db, stranger)).toHaveLength(0);
  });

  it("hides other owners' records and commands", async () => {
    const id = await create();
    await expect(readAgent(context.db, stranger, id)).rejects.toThrow("not found");
    await expect(
      commandAgent(context.db, stranger, {
        requestId: crypto.randomUUID(),
        agentId: id,
        expectedRevision: 1,
        command: "delete",
      }),
    ).rejects.toThrow("not found");
    expect((await readAgent(context.db, owner, id)).status).toBe("paused");
  });

  it("rolls back stale edits without consuming the draft or version", async () => {
    const id = await create();
    const draftId = await draft();
    await command(id, "stop");
    await expect(
      saveAgent(context.db, owner, {
        requestId: crypto.randomUUID(),
        draftId,
        policy: DEFAULT_POLICY,
        agentId: id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("another tab");
    expect((await readAgent(context.db, owner, id)).version).toBe(1);
    const [stored] = await context.db
      .select()
      .from(tables.strategyDrafts)
      .where(eq(tables.strategyDrafts.id, draftId));
    expect(stored?.consumedAt).toBeNull();
  });

  it("keeps versions immutable and pauses edited agents", async () => {
    const id = await create();
    await saveAgent(context.db, owner, {
      requestId: crypto.randomUUID(),
      draftId: await draft(),
      policy: { ...DEFAULT_POLICY, budgetUsd: "200" },
      agentId: id,
      expectedRevision: 1,
    });
    expect(await readAgent(context.db, owner, id)).toMatchObject({
      version: 2,
      status: "paused",
      policy: { budgetUsd: "200" },
    });
    expect(await context.db.select().from(tables.strategyVersions)).toHaveLength(2);
  });

  it("clones only once with a fresh paused identity", async () => {
    const id = await create();
    const input = {
      requestId: crypto.randomUUID(),
      agentId: id,
      expectedRevision: 1,
      command: "clone" as const,
    };
    const clonedId = await commandAgent(context.db, owner, input);
    expect(await commandAgent(context.db, owner, input)).toBe(clonedId);
    const clone = await readAgent(context.db, owner, clonedId);
    expect(clone).toMatchObject({ status: "paused", version: 1, strategy });
    expect(clone.name).not.toBe((await readAgent(context.db, owner, id)).name);
    expect(await listAgents(context.db, owner)).toHaveLength(2);
  });

  it("replays a stop idempotently after its revision changed", async () => {
    const id = await create();
    const input = {
      requestId: crypto.randomUUID(),
      agentId: id,
      expectedRevision: 1,
      command: "stop" as const,
    };
    await commandAgent(context.db, owner, input);
    await commandAgent(context.db, owner, input);
    expect((await readAgent(context.db, owner, id)).revision).toBe(2);
    await expect(
      commandAgent(context.db, owner, { ...input, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("another tab");
  });

  it("global stop affects only its owner and clearing never restarts agents", async () => {
    const id = await create();
    const other = await create(stranger);
    await setGlobalStop(context.db, owner, true, crypto.randomUUID(), 0);
    expect(await killSwitchEngaged(context.db, owner)).toBe(true);
    expect((await readAgent(context.db, owner, id)).status).toBe("stopped");
    expect((await readAgent(context.db, stranger, other)).status).toBe("paused");
    await expect(command(id, "resume")).rejects.toThrow("global stop");
    await setGlobalStop(
      context.db,
      owner,
      false,
      crypto.randomUUID(),
      await globalStopRevision(context.db, owner),
    );
    expect((await readAgent(context.db, owner, id)).status).toBe("stopped");
  });

  it("stops every owner's agent on delegation removal", async () => {
    const a = await create();
    const b = await create();
    await stopUserAgents(context.db, owner, "Stopped because the delegated key was revoked.");
    for (const id of [a, b]) {
      expect(await readAgent(context.db, owner, id)).toMatchObject({
        status: "stopped",
        reason: expect.stringContaining("revoked"),
      });
    }
  });

  it("stops agents and deletes the key atomically only after later finality proves removal", async () => {
    const id = await create();
    await context.db.insert(delegatedKeys).values({
      userId: owner,
      publicKey: "ed25519:test",
      sealedSecret: Buffer.alloc(60),
      createdAt: 1,
      activatedAt: 1,
      activatedAtBlock: 10,
    });
    inference.registration.mockResolvedValue({ registered: false, blockHeight: 10 });
    expect((await readDelegatedKey({ id: owner, accountId: "owner.near" })).state.kind).toBe("active");
    inference.registration.mockResolvedValue({ registered: false, blockHeight: 11 });
    expect((await readDelegatedKey({ id: owner, accountId: "owner.near" })).state.kind).toBe("none");
    expect(await context.db.select().from(delegatedKeys)).toHaveLength(0);
    expect((await readAgent(context.db, owner, id)).status).toBe("stopped");
  });

  it("can stop agents with unreadable stored policies", async () => {
    const id = await create();
    await context.db
      .update(tables.agents)
      .set({ policyJson: "invalid JSON" })
      .where(eq(tables.agents.id, id));
    await setGlobalStop(context.db, owner, true, crypto.randomUUID(), 0);
    const [stored] = await context.db.select().from(tables.agents).where(eq(tables.agents.id, id));
    expect(stored?.status).toBe("stopped");
  });

  it("rejects stale stop clearing and keeps retries out of the audit", async () => {
    const id = crypto.randomUUID();
    await setGlobalStop(context.db, owner, true, id, 0);
    const revision = await globalStopRevision(context.db, owner);
    await setGlobalStop(context.db, owner, true, id, 0);
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(1);
    await setGlobalStop(context.db, owner, true, crypto.randomUUID(), revision);
    await expect(setGlobalStop(context.db, owner, false, crypto.randomUUID(), revision)).rejects.toThrow(
      "another tab",
    );
    expect(await killSwitchEngaged(context.db, owner)).toBe(true);
  });

  it("deduplicates inference through a shared database lease and recovers the saved result", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      pack: "rebalancer" as const,
      strategyText: "Keep equal NEAR and USDC allocations.",
    };
    const results = await Promise.allSettled([
      prepareStrategyDraft(owner, input),
      prepareStrategyDraft(owner, input),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(inference.parse).toHaveBeenCalledTimes(1);
    const saved = await prepareStrategyDraft(owner, input);
    expect(saved.strategy).toEqual(strategy);
    expect(await context.db.select().from(tables.strategyDrafts)).toHaveLength(1);
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(1);
    expect(await context.db.select().from(tables.strategyParseJobs)).toHaveLength(0);
    await expect(
      prepareStrategyDraft(owner, { ...input, strategyText: "Different strategy" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("creates nothing and releases the lease after inference verification fails", async () => {
    inference.parse.mockRejectedValue(new Error("Unverified response"));
    await expect(
      prepareStrategyDraft(owner, {
        requestId: crypto.randomUUID(),
        pack: "rebalancer",
        strategyText: "Equal allocations",
      }),
    ).rejects.toThrow("Unverified");
    expect(await listAgents(context.db, owner)).toHaveLength(0);
    expect(await context.db.select().from(tables.strategyDrafts)).toHaveLength(0);
    expect(await context.db.select().from(tables.strategyParseJobs)).toHaveLength(0);
  });

  it("deletes from active lists while retaining immutable history and retry support", async () => {
    const id = await create();
    const input = {
      requestId: crypto.randomUUID(),
      agentId: id,
      expectedRevision: 1,
      command: "delete" as const,
    };
    await commandAgent(context.db, owner, input);
    expect(await commandAgent(context.db, owner, input)).toBe(id);
    expect(await listAgents(context.db, owner)).toHaveLength(0);
    await expect(readAgent(context.db, owner, id)).rejects.toThrow("not found");
    expect(await context.db.select().from(tables.strategyVersions)).toHaveLength(1);
    expect(await context.db.select().from(tables.agentEvents)).toHaveLength(2);
  });

  it("requires releasing allocated capital before lowering a saved strategy budget", async () => {
    const id = await create();
    await setUserCapitalLimit(context.db, owner, {
      requestId: crypto.randomUUID(),
      amountMicroUsd: "100000000",
    });
    await setAgentCapitalLimit(context.db, owner, {
      requestId: crypto.randomUUID(),
      agentId: id,
      amountMicroUsd: "100000000",
    });
    const draftId = await draft();
    await expect(
      saveAgent(context.db, owner, {
        requestId: crypto.randomUUID(),
        draftId,
        agentId: id,
        expectedRevision: 1,
        policy: { ...DEFAULT_POLICY, budgetUsd: "5", maxTradeUsd: "5" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await readAgent(context.db, owner, id)).version).toBe(1);
    const [review] = await context.db
      .select()
      .from(tables.strategyDrafts)
      .where(eq(tables.strategyDrafts.id, draftId));
    expect(review?.consumedAt).toBeNull();
  });
});
