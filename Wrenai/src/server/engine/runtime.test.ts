import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimes, agents, tradingControls } from "@/server/db/agent-schema";
import { executionTestContext } from "@/server/execution/test-context";
import {
  claimRuntimeSegment,
  claimStrategyCheck,
  failAgentRuntime,
  finishStrategyCheck,
  prepareAgentRuntime,
  readAgentRuntime,
} from "./runtime";
import { agentRuntimeStatus, reconcileAgentOrders } from "./status";
import { INITIAL_TRIGGER_STATE } from "./trigger";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
});
afterEach(async () => context.postgres.close());
function input(): {
  readonly requestId: string;
  readonly agentId: string;
  readonly expectedRevision: number;
  readonly command: "resume";
} {
  return { requestId: crypto.randomUUID(), agentId: context.agentId, expectedRevision: 1, command: "resume" };
}
describe("database-fenced durable agent lifecycle", () => {
  it("stays paused until a queued worker claims it and deduplicates activation/run retries", async () => {
    const request = input();
    const id = await prepareAgentRuntime(context.db, "owner", request);
    expect((await context.db.select().from(agents))[0]?.status).toBe("paused");
    expect(await claimRuntimeSegment(context.db, id, "offline-run-1", 0)).toBe(true);
    expect(await claimRuntimeSegment(context.db, id, "offline-run-1", 0)).toBe(true);
    expect(await claimRuntimeSegment(context.db, id, "offline-run-2", 0)).toBe(false);
    expect(await prepareAgentRuntime(context.db, "owner", request)).toBe(id);
    expect((await context.db.select().from(agents))[0]).toMatchObject({ status: "running", revision: 2 });
    await expect(
      prepareAgentRuntime(context.db, "owner", { ...request, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(prepareAgentRuntime(context.db, "stranger", request)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("rejects skipped/duplicate continuation segments and replacement activations fence old workers", async () => {
    const first = await prepareAgentRuntime(context.db, "owner", input());
    await claimRuntimeSegment(context.db, first, "offline-run-1", 0);
    expect(await claimRuntimeSegment(context.db, first, "offline-skipped", 2)).toBe(false);
    expect(await claimRuntimeSegment(context.db, first, "offline-run-2", 1)).toBe(true);
    expect(await claimRuntimeSegment(context.db, first, "offline-duplicate", 1)).toBe(false);
    expect(await claimStrategyCheck(context.db, first, "offline-run-1")).toBeNull();
    await context.db
      .update(agents)
      .set({ status: "paused", revision: 3 })
      .where(eq(agents.id, context.agentId));
    const second = await prepareAgentRuntime(context.db, "owner", { ...input(), expectedRevision: 3 });
    expect(await readAgentRuntime(context.db, first)).toBeNull();
    expect(await claimRuntimeSegment(context.db, first, "offline-run-3", 2)).toBe(false);
    expect(await claimRuntimeSegment(context.db, second, "offline-run-4", 0)).toBe(true);
  });
  it("gives global stop precedence over a queued activation", async () => {
    const id = await prepareAgentRuntime(context.db, "owner", input());
    await context.db
      .insert(tradingControls)
      .values({ userId: "owner", killSwitch: true, updatedAt: Date.now() });
    await expect(claimRuntimeSegment(context.db, id, "offline-run-1", 0)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await context.db.select().from(agents))[0]?.status).toBe("paused");
    await failAgentRuntime(context.db, id, "offline-run-1");
    expect((await context.db.select().from(agents))[0]?.status).toBe("paused");
    expect((await readAgentRuntime(context.db, id))?.state).toBe("stopped");
  });
  it("allows only one strategy-check lease, fences stale writes and stops on revision changes", async () => {
    const id = await prepareAgentRuntime(context.db, "owner", input());
    await claimRuntimeSegment(context.db, id, "offline-run-1", 0);
    const claim = await claimStrategyCheck(context.db, id, "offline-run-1");
    if (!claim) {
      throw new Error("Missing offline strategy claim.");
    }
    expect(await claimStrategyCheck(context.db, id, "offline-run-1")).toBeNull();
    await expect(
      finishStrategyCheck(context.db, id, crypto.randomUUID(), Date.now() + 60_000, "offline stale", false),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await finishStrategyCheck(context.db, id, claim.token, Date.now(), "offline complete", false);
    await context.db
      .update(agents)
      .set({ status: "paused", revision: 3 })
      .where(eq(agents.id, context.agentId));
    expect(await claimStrategyCheck(context.db, id, "offline-run-1")).toBeNull();
    expect((await context.db.select().from(agentRuntimes))[0]?.state).toBe("stopped");
  });
  it("preserves trigger observations across activation retries and records completion durably", async () => {
    const id = await prepareAgentRuntime(context.db, "owner", input());
    await claimRuntimeSegment(context.db, id, "offline-run-1", 0);
    const claim = await claimStrategyCheck(context.db, id, "offline-run-1");
    if (!claim) {
      throw new Error("Missing offline strategy claim.");
    }
    const state = { ...INITIAL_TRIGGER_STATE, lastMarketAt: Date.now(), phase: "completed" as const };
    await finishStrategyCheck(context.db, id, claim.token, Date.now() + 5000, "Completed.", false, {
      triggerState: state,
      completed: true,
    });
    expect((await readAgentRuntime(context.db, id))?.strategyStateJson).toBe(JSON.stringify(state));
    expect((await context.db.select().from(agents))[0]).toMatchObject({ status: "stopped", revision: 3 });
    const next = await prepareAgentRuntime(context.db, "owner", { ...input(), expectedRevision: 3 });
    expect((await readAgentRuntime(context.db, next))?.strategyStateJson).toBe(JSON.stringify(state));
    await expect(agentRuntimeStatus(context.db, "stranger", context.agentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(reconcileAgentOrders(context.db, "stranger", context.agentId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("keeps a failed runtime blocked through continuation claims instead of reactivating trading", async () => {
    const id = await prepareAgentRuntime(context.db, "owner", input());
    await claimRuntimeSegment(context.db, id, "offline-run-1", 0);
    await failAgentRuntime(context.db, id, "offline-run-1");
    expect((await readAgentRuntime(context.db, id))?.state).toBe("blocked");
    await claimRuntimeSegment(context.db, id, "offline-run-2", 1);
    expect((await readAgentRuntime(context.db, id))?.state).toBe("blocked");
    expect((await context.db.select().from(agents))[0]?.status).toBe("error");
  });
});
