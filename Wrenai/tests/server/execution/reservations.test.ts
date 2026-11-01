import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, tradingControls } from "@/server/db/agent-schema";
import { executionActions, executionEvents, executionInventory } from "@/server/db/execution-schema";
import { delegatedKeys } from "@/server/db/schema";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { ownedExecution } from "@/server/execution/records";
import { approveExecution, cancelReservedExecution, reserveExecution } from "@/server/execution/reservations";
import { DEFAULT_POLICY } from "@/shared/agents";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;

describe("transactional execution reservations", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("recovers a lost response without another reservation and rejects changed plan bytes", async () => {
    const plan = executionPlan(context.agentId);
    const first = await reserveExecution(context.db, "owner", plan);
    expect(await reserveExecution(context.db, "owner", plan)).toEqual(first);
    await expect(
      reserveExecution(context.db, "owner", { ...plan, minOutputUnits: "101" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
    expect(await context.db.select().from(executionEvents)).toHaveLength(1);
  });

  it("prevents two concurrent actions from reserving the same input inventory", async () => {
    const results = await Promise.allSettled([
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { inputUnits: "7000" })),
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { inputUnits: "7000" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
  });

  it("keeps owners and public/private inventory separate", async () => {
    await expect(
      reserveExecution(context.db, "stranger", executionPlan(context.agentId)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { scope: "intents" })),
    ).rejects.toMatchObject({ code: "not_ready" });
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(ownedExecution(context.db, "stranger", action.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(cancelReservedExecution(context.db, "stranger", action.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("enforces exact amounts, positive quantities and bounded quote expiry", async () => {
    for (const inputUnits of ["1e3", "0", "-1", "1.5", 1000]) {
      await expect(
        reserveExecution(context.db, "owner", { ...executionPlan(context.agentId), inputUnits }),
      ).rejects.toThrow();
    }
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { expiresAt: 1 })),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(
      reserveExecution(
        context.db,
        "owner",
        executionPlan(context.agentId, { expiresAt: Date.now() + 600_000 }),
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });

  it("uses bigint for inventory above Number.MAX_SAFE_INTEGER", async () => {
    await observeInventory(context.db, "confidential", "9007199254740993");
    await fundTestAgent(context.db, context.agentId, "9007199254730993", "1");
    const first = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "9007199254740992" }),
    );
    expect(first.inputUnits).toBe(9007199254740992n);
    const last = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "1" }),
    );
    expect(last.inputUnits).toBe(1n);
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { inputUnits: "1" })),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
  });

  it("applies current per-trade, slippage and pending reservation ceilings", async () => {
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { notionalMicroUsd: "10000001" })),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { slippageBps: 51 })),
    ).rejects.toMatchObject({ code: "limit" });
    await context.db
      .update(agents)
      .set({
        policyJson: JSON.stringify({
          ...DEFAULT_POLICY,
          budgetUsd: "15",
          approvalMode: "autonomous",
          cooldownSeconds: 0,
        }),
      })
      .where(eq(agents.id, context.agentId));
    await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "limit" },
    );
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
  });

  it("requires an approval bound to the complete immutable plan", async () => {
    await context.db
      .update(agents)
      .set({ policyJson: JSON.stringify({ ...DEFAULT_POLICY, approvalMode: "every_action" }) })
      .where(eq(agents.id, context.agentId));
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(claimExecution(context.db, "owner", action.id)).rejects.toMatchObject({ code: "not_ready" });
    await expect(approveExecution(context.db, "owner", action.id, "c".repeat(64))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(approveExecution(context.db, "stranger", action.id, action.planHash)).rejects.toMatchObject({
      code: "not_found",
    });
    await approveExecution(context.db, "owner", action.id, action.planHash);
    await approveExecution(context.db, "owner", action.id, action.planHash);
    expect((await claimExecution(context.db, "owner", action.id)).mode).toBe("submit");
    expect(
      (await context.db.select().from(executionEvents)).filter((event) => event.kind === "approved"),
    ).toHaveLength(1);
  });

  it("checks stop, revision and delegated authorization again immediately before submission", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const lease = await claimExecution(context.db, "owner", action.id);
    const payload = { payloadHash: "b".repeat(64), providerRequestId: crypto.randomUUID() };
    await context.db.insert(tradingControls).values({ userId: "owner", killSwitch: true, updatedAt: 1 });
    await expect(beginSubmission(context.db, "owner", action.id, lease.token, payload)).rejects.toMatchObject(
      { code: "not_ready" },
    );
    await context.db.delete(tradingControls);
    await context.db.update(agents).set({ revision: 2 }).where(eq(agents.id, context.agentId));
    await expect(beginSubmission(context.db, "owner", action.id, lease.token, payload)).rejects.toMatchObject(
      { code: "conflict" },
    );
    await context.db.update(agents).set({ revision: 1 }).where(eq(agents.id, context.agentId));
    await context.db.delete(delegatedKeys);
    await expect(beginSubmission(context.db, "owner", action.id, lease.token, payload)).rejects.toMatchObject(
      { code: "not_ready" },
    );
    expect((await ownedExecution(context.db, "owner", action.id)).status).toBe("reserved");
  });

  it("rejects stale inventory and invalidates observations racing a new reservation", async () => {
    const syncToken = await beginInventorySync(context.db, "owner", "confidential");
    await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(
      finishInventorySync(context.db, "owner", { scope: "confidential", syncToken, balances: [] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await context.db.update(executionInventory).set({ observedAt: 0 });
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "not_ready" },
    );
  });

  it("releases only unsent cancellations and preserves a possibly submitted reservation", async () => {
    const action = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "10000" }),
    );
    await cancelReservedExecution(context.db, "owner", action.id);
    await cancelReservedExecution(context.db, "owner", action.id);
    const next = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "10000" }),
    );
    await startTestSubmission(context.db, next.id);
    await expect(cancelReservedExecution(context.db, "owner", next.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { inputUnits: "1" })),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
  });

  it("auto-approves only amounts within the user's above-size threshold", async () => {
    await context.db
      .update(agents)
      .set({
        policyJson: JSON.stringify({
          ...DEFAULT_POLICY,
          approvalMode: "above_size",
          approvalThresholdUsd: "5",
          cooldownSeconds: 0,
        }),
      })
      .where(eq(agents.id, context.agentId));
    const low = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { notionalMicroUsd: "5000000" }),
    );
    const high = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { notionalMicroUsd: "5000001" }),
    );
    expect((await claimExecution(context.db, "owner", low.id)).mode).toBe("submit");
    await expect(claimExecution(context.db, "owner", high.id)).rejects.toMatchObject({ code: "not_ready" });
  });

  it("enforces event ownership in the database as well as the service", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(
      context.db.insert(executionEvents).values({
        id: crypto.randomUUID(),
        userId: "stranger",
        actionId: action.id,
        kind: "invalid_owner",
        detailJson: "{}",
        createdAt: Date.now(),
      }),
    ).rejects.toThrow();
    expect(await context.db.select().from(executionEvents)).toHaveLength(1);
  });
});
