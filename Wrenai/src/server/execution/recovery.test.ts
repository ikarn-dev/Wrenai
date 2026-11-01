import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { executionActions, executionWallets } from "@/server/db/execution-schema";
import { policySchema } from "@/shared/agents";
import { availableInventory, beginInventorySync, finishInventorySync } from "./inventory";
import { beginSubmission, claimExecution, recordSubmissionStatus } from "./ownership";
import * as clockRecords from "./records";
import { ownedExecution } from "./records";
import { reserveExecution } from "./reservations";
import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "./test-context";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("execution worker recovery and inventory fencing", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await context.postgres.close();
  });

  it("gives one worker ownership and rejects stale leases before submission", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const first = await claimExecution(context.db, "owner", action.id);
    await expect(claimExecution(context.db, "owner", action.id)).rejects.toMatchObject({ code: "conflict" });
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(eq(executionActions.id, action.id));
    const replacement = await claimExecution(context.db, "owner", action.id);
    expect(replacement.mode).toBe("submit");
    const payload = { payloadHash: "b".repeat(64), providerRequestId: crypto.randomUUID() };
    await expect(beginSubmission(context.db, "owner", action.id, first.token, payload)).rejects.toMatchObject(
      { code: "lease_lost" },
    );
    await beginSubmission(context.db, "owner", action.id, replacement.token, payload);
  });

  it.each(["submitting", "submitted", "unknown"] as const)(
    "recovers %s actions by reconciliation, never blind resubmission",
    async (status) => {
      const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
      const { token } = await startTestSubmission(context.db, action.id);
      if (status !== "submitting") {
        await recordSubmissionStatus(context.db, "owner", action.id, token, status);
      }
      const stored = await ownedExecution(context.db, "owner", action.id);
      await context.db
        .update(executionActions)
        .set({ leaseExpiresAt: 0 })
        .where(eq(executionActions.id, action.id));
      const recovered = await claimExecution(context.db, "owner", action.id);
      expect(recovered.mode).toBe("reconcile");
      await expect(
        beginSubmission(context.db, "owner", action.id, recovered.token, {
          payloadHash: "c".repeat(64),
          providerRequestId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await ownedExecution(context.db, "owner", action.id)).payloadHash).toBe(stored.payloadHash);
      expect((await ownedExecution(context.db, "owner", action.id)).providerRequestId).toBe(
        stored.providerRequestId,
      );
      const syncToken = await beginInventorySync(context.db, "owner", "confidential");
      await finishInventorySync(context.db, "owner", { scope: "confidential", syncToken, balances: [] });
      await expect(
        availableInventory(context.db, "owner", "confidential", stored.inputAssetId, Date.now()),
      ).rejects.toMatchObject({ code: "not_ready" });
    },
  );

  it("continues reconciliation after stop or expiry without authorizing another submission", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await startTestSubmission(context.db, action.id);
    await context.db
      .update(agents)
      .set({ status: "stopped", revision: 2 })
      .where(eq(agents.id, context.agentId));
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(eq(executionActions.id, action.id));
    vi.spyOn(clockRecords, "databaseTime").mockResolvedValue(action.expiresAt + 1);
    const recovery = await claimExecution(context.db, "owner", action.id);
    expect(recovery.mode).toBe("reconcile");
    await recordSubmissionStatus(context.db, "owner", action.id, recovery.token, "unknown");
    expect((await ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });

  it("fences expired inventory readers and rejects duplicate assets", async () => {
    const old = await beginInventorySync(context.db, "owner", "confidential");
    await context.db.update(executionWallets).set({ syncExpiresAt: 0 });
    const replacement = await beginInventorySync(context.db, "owner", "confidential");
    await expect(
      finishInventorySync(context.db, "owner", { scope: "confidential", syncToken: old, balances: [] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      finishInventorySync(context.db, "owner", {
        scope: "confidential",
        syncToken: replacement,
        balances: [
          { assetId: "duplicate", amountUnits: "1" },
          { assetId: "duplicate", amountUnits: "2" },
        ],
      }),
    ).rejects.toThrow();
    await finishInventorySync(context.db, "owner", {
      scope: "confidential",
      syncToken: replacement,
      balances: [],
    });
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "insufficient_funds" },
    );
  });

  it("blocks submission after a fresh observation reveals an inventory shortfall", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const lease = await claimExecution(context.db, "owner", action.id);
    await observeInventory(context.db, "confidential", "999");
    await expect(
      beginSubmission(context.db, "owner", action.id, lease.token, {
        payloadHash: "b".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
  });

  it.each([
    { cooldownSeconds: 60, maxTradesPerHour: 6 },
    { cooldownSeconds: 0, maxTradesPerHour: 1 },
  ])(
    "applies cooldown/frequency policy $cooldownSeconds/$maxTradesPerHour across workers",
    async (limits) => {
      const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
      if (agent === undefined) {
        throw new Error("Missing fixture agent.");
      }
      const policy = policySchema.parse(JSON.parse(agent.policyJson));
      await context.db
        .update(agents)
        .set({ policyJson: JSON.stringify({ ...policy, ...limits }) })
        .where(eq(agents.id, context.agentId));
      const first = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
      const second = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
      await startTestSubmission(context.db, first.id);
      await expect(startTestSubmission(context.db, second.id)).rejects.toMatchObject({ code: "limit" });
    },
  );
});
