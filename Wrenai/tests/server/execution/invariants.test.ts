import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { availableInventory, beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { databaseTime } from "@/server/execution/records";
import { reserveExecution } from "@/server/execution/reservations";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("review regression invariants", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("refreshes unrelated assets while keeping unresolved input/output assets quarantined", async () => {
    const plan = executionPlan(context.agentId);
    const action = await reserveExecution(context.db, "owner", plan);
    await startTestSubmission(context.db, action.id);
    const syncToken = await beginInventorySync(context.db, "owner", "confidential");
    await finishInventorySync(context.db, "owner", {
      scope: "confidential",
      syncToken,
      balances: [
        { assetId: plan.inputAssetId, amountUnits: "10000" },
        { assetId: "nep141:unrelated.near", amountUnits: "2000" },
      ],
    });
    const now = await databaseTime(context.db);
    expect(await availableInventory(context.db, "owner", "confidential", "nep141:unrelated.near", now)).toBe(
      2000n,
    );
    await expect(
      availableInventory(context.db, "owner", "confidential", plan.inputAssetId, now),
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("rejects invalid states at the SQL boundary", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(
      context.db.execute(sql`UPDATE execution_actions SET status = ${"invalid"} WHERE id = ${action.id}`),
    ).rejects.toThrow();
    expect(
      (await context.db.select().from(executionActions).where(eq(executionActions.id, action.id)))[0]?.status,
    ).toBe("reserved");
  });

  it("rejects audit event updates and deletes at the SQL boundary", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(
      context.db
        .update(executionEvents)
        .set({ detailJson: "{}" })
        .where(eq(executionEvents.actionId, action.id)),
    ).rejects.toThrow();
    await expect(
      context.db.delete(executionEvents).where(eq(executionEvents.actionId, action.id)),
    ).rejects.toThrow();
    expect(await context.db.select().from(executionEvents)).toHaveLength(1);
  });
});
