import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { executionActions, executionEvents, executionFills } from "@/server/db/execution-schema";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import { availableInventory, beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { claimExecution } from "@/server/execution/ownership";
import { checkReservationLimits, currentExecutionPolicy } from "@/server/execution/policy";
import { ownedExecution } from "@/server/execution/records";
import { reserveExecution } from "@/server/execution/reservations";
import { DEFAULT_POLICY } from "@/shared/agents";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("immutable execution receipts and settlement", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("records partial fills once and releases funds only after terminal settlement plus fresh inventory", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    const fill = {
      providerEventId: "provider-fill-1",
      inputUnits: "400",
      outputUnits: "40",
      inputValueMicroUsd: "4000000",
      feeMicroUsd: "10000",
      occurredAt: worker.occurredAt,
    };
    await recordExecutionFill(context.db, "owner", action.id, worker.token, fill);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, fill);
    expect(await context.db.select().from(executionFills)).toHaveLength(1);
    const syncToken = await beginInventorySync(context.db, "owner", "confidential");
    await finishInventorySync(context.db, "owner", { scope: "confidential", syncToken, balances: [] });
    await expect(
      availableInventory(context.db, "owner", "confidential", action.inputAssetId, Date.now()),
    ).rejects.toMatchObject({ code: "not_ready" });
    const terminal = { providerReceiptId: "provider-terminal-1", refundedInputUnits: "600" };
    await settleExecution(context.db, "owner", action.id, worker.token, terminal);
    await settleExecution(context.db, "owner", action.id, worker.token, terminal);
    expect((await ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "not_ready" },
    );
    await observeInventory(context.db, "confidential", "9600");
    expect((await ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
    await reserveExecution(context.db, "owner", executionPlan(context.agentId, { inputUnits: "9600" }));
    expect(await context.db.select().from(executionFills)).toHaveLength(1);
    expect(
      (await context.db.select().from(executionEvents)).filter(
        (event) => event.kind === "settled_awaiting_inventory",
      ),
    ).toHaveLength(1);
  });

  it("rejects a replay with different quantities or another action", async () => {
    const first = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const second = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, first.id);
    const secondWorker = await claimExecution(context.db, "owner", second.id);
    const fill = {
      providerEventId: "same-receipt",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "10000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    };
    await recordExecutionFill(context.db, "owner", first.id, worker.token, fill);
    await expect(
      recordExecutionFill(context.db, "owner", first.id, worker.token, { ...fill, outputUnits: "101" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recordExecutionFill(context.db, "owner", second.id, secondWorker.token, fill),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recordExecutionFill(context.db, "stranger", first.id, worker.token, fill),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not release unknown input or accept an overfill", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await expect(
      settleExecution(context.db, "owner", action.id, worker.token, {
        providerReceiptId: "incomplete",
        refundedInputUnits: "999",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recordExecutionFill(context.db, "owner", action.id, worker.token, {
        providerEventId: "overfill",
        inputUnits: "1001",
        outputUnits: "100",
        inputValueMicroUsd: "10000000",
        feeMicroUsd: "0",
        occurredAt: worker.occurredAt,
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
    expect((await ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });

  it("rounds partial-fill minimum output up and leaves bad settlement quarantined", async () => {
    const action = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "3", minOutputUnits: "10" }),
    );
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "bad-price",
      inputUnits: "1",
      outputUnits: "3",
      inputValueMicroUsd: "3000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    });
    await expect(
      settleExecution(context.db, "owner", action.id, worker.token, {
        providerReceiptId: "terminal-bad-price",
        refundedInputUnits: "2",
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect((await ownedExecution(context.db, "owner", action.id)).status).toBe("submitting");
    expect((await ownedExecution(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });

  it("accounts for a complete refund without fabricating a fill or PnL", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await settleExecution(context.db, "owner", action.id, worker.token, {
      providerReceiptId: "refund",
      refundedInputUnits: "1000",
    });
    await expect(
      settleExecution(context.db, "owner", action.id, worker.token, {
        providerReceiptId: "different",
        refundedInputUnits: "1000",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(claimExecution(context.db, "owner", action.id)).rejects.toMatchObject({ code: "conflict" });
    await observeInventory(context.db);
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
    expect((await ownedExecution(context.db, "owner", action.id)).status).toBe("settled");
  });

  it("rejects new receipts from a stale worker but allows exact receipt recovery after lease loss", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    const fill = {
      providerEventId: "known-fill",
      inputUnits: "400",
      outputUnits: "40",
      inputValueMicroUsd: "4000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    };
    await recordExecutionFill(context.db, "owner", action.id, worker.token, fill);
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(eq(executionActions.id, action.id));
    const replacement = await claimExecution(context.db, "owner", action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, fill);
    await expect(
      recordExecutionFill(context.db, "owner", action.id, worker.token, {
        ...fill,
        providerEventId: "late-new-fill",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await settleExecution(context.db, "owner", action.id, replacement.token, {
      providerReceiptId: "recovered-terminal",
      refundedInputUnits: "600",
    });
  });

  it("never reuses a terminal receipt to settle a different action", async () => {
    const first = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const second = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const a = await startTestSubmission(context.db, first.id);
    const receipt = { providerReceiptId: "one-provider-terminal", refundedInputUnits: "1000" };
    await settleExecution(context.db, "owner", first.id, a.token, receipt);
    await observeInventory(context.db);
    const b = await startTestSubmission(context.db, second.id);
    await expect(settleExecution(context.db, "owner", second.id, b.token, receipt)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await ownedExecution(context.db, "owner", second.id)).status).toBe("submitting");
  });

  it("counts delayed receipts in current risk usage, with included fees counted once", async () => {
    await context.db
      .update(agents)
      .set({
        policyJson: JSON.stringify({
          ...DEFAULT_POLICY,
          dailyCapUsd: "10",
          approvalMode: "autonomous",
          cooldownSeconds: 0,
        }),
      })
      .where(eq(agents.id, context.agentId));
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "daily-fill",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "8000000",
      feeMicroUsd: "1000000",
      occurredAt: 0,
    });
    await settleExecution(context.db, "owner", action.id, worker.token, {
      providerReceiptId: "daily-terminal",
      refundedInputUnits: "0",
    });
    await observeInventory(context.db, "confidential", "9000");
    await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { notionalMicroUsd: "2000000" }),
    );
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { notionalMicroUsd: "1" })),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("does not count a partial debit both as spent and as still-reserved risk", async () => {
    await context.db
      .update(agents)
      .set({
        policyJson: JSON.stringify({
          ...DEFAULT_POLICY,
          dailyCapUsd: "14",
          approvalMode: "autonomous",
          cooldownSeconds: 0,
        }),
      })
      .where(eq(agents.id, context.agentId));
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "partial-debit",
      inputUnits: "400",
      outputUnits: "40",
      inputValueMicroUsd: "4000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    });
    const policy = await currentExecutionPolicy(context.db, "owner", executionPlan(context.agentId));
    await checkReservationLimits(
      context.db,
      "owner",
      executionPlan(context.agentId, { notionalMicroUsd: "4000000" }),
      policy,
      Date.now(),
    );
    await expect(
      checkReservationLimits(
        context.db,
        "owner",
        executionPlan(context.agentId, { notionalMicroUsd: "4000001" }),
        policy,
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: "limit" });
  });
});
