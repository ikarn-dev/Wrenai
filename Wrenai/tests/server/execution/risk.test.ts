import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { addTestAgent, allocateTestAgent } from "@tests/server/positions/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executionActions, executionWallets } from "@/server/db/execution-schema";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import type { ExecutionPlan } from "@/server/execution/contracts";
import { beginSubmission, claimExecution, recordSubmissionStatus } from "@/server/execution/ownership";
import { databaseTime, executionHash, ownedExecution } from "@/server/execution/records";
import { approveExecution, reserveExecution } from "@/server/execution/reservations";
import { readSpendingUsage, readSubmissionUsage } from "@/server/execution/usage";
import { readUserRiskPolicy, setUserRiskPolicy } from "@/server/guard/user-policy";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;

async function otherFundedAgent(): Promise<string> {
  await observeInventory(context.db, "confidential", "20000");
  const other = await addTestAgent(context.db);
  await allocateTestAgent(context.db, other);
  await fundTestAgent(context.db, other);
  return other;
}

async function revisePolicy(): Promise<void> {
  const current = await readUserRiskPolicy(context.db, "owner");
  if (current === null) {
    throw new Error("Missing test policy.");
  }
  await setUserRiskPolicy(context.db, "owner", {
    requestId: crypto.randomUUID(),
    expectedRevision: current.revision,
    policy: { ...current.policy, dailyCapUsd: "14" },
  });
}

// Historical adapter records only: public execution remains disabled in the real reservation path.
async function historicalReservation(userId: string, plan: ExecutionPlan): Promise<void> {
  const now = await databaseTime(context.db);
  await context.db.insert(executionWallets).values({ userId, scope: plan.scope }).onConflictDoNothing();
  await context.db.insert(executionActions).values({
    id: crypto.randomUUID(),
    userId,
    agentId: plan.agentId,
    requestId: plan.requestId,
    planHash: executionHash(plan),
    planJson: JSON.stringify(plan),
    agentRevision: 1,
    strategyVersion: 1,
    policyHash: "a".repeat(64),
    scope: plan.scope,
    inputAssetId: plan.inputAssetId,
    outputAssetId: plan.outputAssetId,
    inputUnits: BigInt(plan.inputUnits),
    minOutputUnits: BigInt(plan.minOutputUnits),
    notionalMicroUsd: BigInt(plan.notionalMicroUsd),
    expiresAt: plan.expiresAt,
    status: "reserved",
    signingPublicKey: "offline",
    createdAt: now,
    updatedAt: now,
  });
}

describe("account-wide execution risk enforcement", () => {
  beforeEach(async () => {
    context = await executionTestContext({}, { dailyCapUsd: "15" });
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("blocks absent policies, unlisted assets and public fallback", async () => {
    const other = await addTestAgent(context.db, "stranger");
    await expect(reserveExecution(context.db, "stranger", executionPlan(other))).rejects.toMatchObject({
      code: "not_ready",
      message: "The original action's account policy is unavailable. Review a new plan.",
    });
    await expect(
      reserveExecution(
        context.db,
        "owner",
        executionPlan(context.agentId, {
          outputAssetId: "nep141:not-allowed.near",
        }),
      ),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      reserveExecution(context.db, "owner", executionPlan(context.agentId, { scope: "intents" })),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });

  it("reserves against the shared cap across agents without weakening per-agent limits", async () => {
    const other = await otherFundedAgent();
    await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await reserveExecution(context.db, "owner", executionPlan(other, { notionalMicroUsd: "5000000" }));
    await expect(
      reserveExecution(context.db, "owner", executionPlan(other, { notionalMicroUsd: "1" })),
    ).rejects.toMatchObject({ code: "limit" });
    const usage = await readSpendingUsage(context.db, "owner", other, await databaseTime(context.db));
    expect(usage.userPendingMicroUsd).toBe(15_000_000n);
    expect(usage.agentPendingMicroUsd).toBe(5_000_000n);
    await expect(
      reserveExecution(context.db, "owner", executionPlan(other, { notionalMicroUsd: "10000001" })),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("uses explicit per-agent budgets for new plans while keeping legacy policy bindings unchanged", async () => {
    const other = await otherFundedAgent();
    const mode = { budgetMode: "per_agent", riskPolicyRevision: 0 } as const;
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId, mode));
    await reserveExecution(context.db, "owner", executionPlan(other, mode));
    expect(
      (await readSpendingUsage(context.db, "owner", other, await databaseTime(context.db)))
        .userPendingMicroUsd,
    ).toBe(20_000_000n);
    await revisePolicy();
    expect((await claimExecution(context.db, "owner", action.id)).mode).toBe("submit");
    await expect(
      reserveExecution(context.db, "owner", executionPlan(other, { ...mode, notionalMicroUsd: "10000001" })),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      reserveExecution(context.db, "owner", executionPlan(other, { riskPolicyRevision: 0 })),
    ).rejects.toThrow();
    await expect(
      reserveExecution(
        context.db,
        "owner",
        executionPlan(other, { budgetMode: "per_agent", riskPolicyRevision: 2 }),
      ),
    ).rejects.toThrow();
  });

  it("serializes competing reservations across agents under one owner", async () => {
    const other = await otherFundedAgent();
    const results = await Promise.allSettled([
      reserveExecution(context.db, "owner", executionPlan(context.agentId)),
      reserveExecution(context.db, "owner", executionPlan(other)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await context.db.select().from(executionActions)).toHaveLength(1);
  });

  it("includes other account scopes but excludes other users from shared pending risk", async () => {
    const strangerAgent = await addTestAgent(context.db, "stranger");
    await historicalReservation("stranger", executionPlan(strangerAgent));
    await historicalReservation(
      "owner",
      executionPlan(context.agentId, { scope: "intents", notionalMicroUsd: "6000000" }),
    );
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "limit" },
    );
    const usage = await readSpendingUsage(
      context.db,
      "owner",
      context.agentId,
      await databaseTime(context.db),
    );
    expect(usage.userPendingMicroUsd).toBe(6_000_000n);
    expect(usage.userSpent24hMicroUsd).toBe(0n);
  });

  it.each(["approval", "claim", "submission"] as const)(
    "rejects a changed account policy at %s",
    async (step) => {
      const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
      const lease = step === "submission" ? await claimExecution(context.db, "owner", action.id) : null;
      await revisePolicy();
      const attempt =
        step === "approval"
          ? approveExecution(context.db, "owner", action.id, action.planHash)
          : step === "claim"
            ? claimExecution(context.db, "owner", action.id)
            : beginSubmission(context.db, "owner", action.id, lease?.token ?? "", {
                payloadHash: "b".repeat(64),
                providerRequestId: crypto.randomUUID(),
              });
      await expect(attempt).rejects.toMatchObject({ code: "conflict" });
      expect((await ownedExecution(context.db, "owner", action.id)).startedAt).toBeNull();
    },
  );

  it("requires the current revision for a newly proposed plan", async () => {
    await revisePolicy();
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "conflict" },
    );
    await reserveExecution(context.db, "owner", executionPlan(context.agentId, { riskPolicyRevision: 2 }));
  });

  it("counts partial debits once, retains unresolved risk and uses receipt time instead of provider time", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    const receipt = {
      providerEventId: "partial-risk",
      inputUnits: "400",
      outputUnits: "40",
      inputValueMicroUsd: "4000000",
      feeMicroUsd: "1000000",
      occurredAt: 0,
    };
    await recordExecutionFill(context.db, "owner", action.id, worker.token, receipt);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, receipt);
    const now = await databaseTime(context.db);
    expect(await readSpendingUsage(context.db, "owner", context.agentId, now)).toEqual({
      userSpent24hMicroUsd: 4_000_000n,
      agentSpent24hMicroUsd: 4_000_000n,
      userPendingMicroUsd: 6_000_000n,
      agentPendingMicroUsd: 6_000_000n,
    });
    const expired = await readSpendingUsage(context.db, "owner", context.agentId, now + 86_400_001);
    expect(expired.userSpent24hMicroUsd).toBe(0n);
    expect(expired.userPendingMicroUsd).toBe(6_000_000n);
    const excluded = await readSpendingUsage(context.db, "owner", context.agentId, now, action.id);
    expect(excluded.userSpent24hMicroUsd).toBe(4_000_000n);
    expect(excluded.userPendingMicroUsd).toBe(0n);
    await settleExecution(context.db, "owner", action.id, worker.token, {
      providerReceiptId: "partial-final",
      refundedInputUnits: "600",
    });
    await observeInventory(context.db, "confidential", "9600");
    const released = await readSpendingUsage(
      context.db,
      "owner",
      context.agentId,
      await databaseTime(context.db),
    );
    expect(released.userSpent24hMicroUsd).toBe(4_000_000n);
    expect(released.userPendingMicroUsd).toBe(0n);
  });

  it("counts a possibly submitted action once and keeps reconciliation available after a policy change", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordSubmissionStatus(context.db, "owner", action.id, worker.token, "unknown");
    await revisePolicy();
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(eq(executionActions.id, action.id));
    expect((await claimExecution(context.db, "owner", action.id)).mode).toBe("reconcile");
    const usage = await readSubmissionUsage(
      context.db,
      "owner",
      context.agentId,
      await databaseTime(context.db),
    );
    expect(usage.submissionsLastHour).toBe(1n);
    expect(usage.lastSubmissionAt).toBe(BigInt(worker.occurredAt));
  });
});
