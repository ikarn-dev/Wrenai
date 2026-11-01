import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defiDisposals,
  defiPositionClaims,
  defiPositions,
  executionPermissions,
  executionReceipts,
} from "@/server/db/defi-schema";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { positionReservations } from "@/server/db/position-schema";
import { attributedPrincipal } from "@/server/positions/capital-records";
import { readAgentPositions } from "@/server/positions/report";
import { recordExecutionFill } from "./accounting";
import { settleDefiExecution } from "./defi-accounting";
import { defiPlanSchema } from "./defi-contracts";
import { reserveDefiExecution } from "./defi-reservations";
import {
  defiTestContext,
  fixtureNear,
  fixtureUsdc,
  liquidityPlan,
  liquidityReceipt,
  nativeInventory,
  permissionFixture,
} from "./defi-test-context";
import { availableInventory } from "./inventory";
import { beginSubmission, claimExecution } from "./ownership";
import { confirmExecutionPermission, revokeExecutionPermission } from "./permissions";
import { databaseTime, ownedLedgerAction } from "./records";
import { cancelReservedExecution, reserveExecution } from "./reservations";
import { executionPlan, fundTestAgent, observeInventory } from "./test-context";
import { readSpendingUsage } from "./usage";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof defiTestContext>>;

async function startAction(actionId: string): Promise<string> {
  const worker = await claimExecution(context.db, "owner", actionId);
  await beginSubmission(context.db, "owner", actionId, worker.token, {
    payloadHash: "b".repeat(64),
    providerRequestId: crypto.randomUUID(),
  });
  return worker.token;
}

describe("one ledger for swaps and DeFi resources", () => {
  beforeEach(async () => {
    context = await defiTestContext();
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("atomically reserves both LP assets and the position, without inventing swap output", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    const action = await reserveDefiExecution(context.db, "owner", plan);
    expect(action.kind).toBe("defi");
    expect(action.inputUnits).toBeNull();
    expect(action.outputAssetId).toBeNull();
    expect((await reserveDefiExecution(context.db, "owner", plan)).id).toBe(action.id);
    expect(await context.db.select().from(positionReservations)).toHaveLength(2);
    expect(await context.db.select().from(defiPositionClaims)).toHaveLength(1);
    expect(await availableInventory(context.db, "owner", "native_near", fixtureNear, Date.now())).toBe(8000n);
    await expect(
      reserveDefiExecution(context.db, "owner", { ...plan, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(reserveDefiExecution(context.db, "stranger", plan)).rejects.toThrow();
    expect(await context.db.select().from(executionFills)).toHaveLength(0);
  });

  it("rolls back all claims when the second asset is insufficient, and rejects malformed quantities", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    await expect(
      reserveDefiExecution(context.db, "owner", {
        ...plan,
        cash: [plan.cash[0], { assetId: fixtureNear, maxDebitUnits: "10001", minCreditUnits: "0" }],
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    expect(await context.db.select().from(positionReservations)).toHaveLength(0);
    expect(
      defiPlanSchema.safeParse({ ...plan, positions: [{ ...plan.positions[0], maxAfterUnits: "1e10" }] })
        .success,
    ).toBe(false);
  });

  it("records real LP shares, conserves principal, rejects forged receipt data and waits for inventory", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    const action = await reserveDefiExecution(context.db, "owner", plan);
    const token = await startAction(action.id);
    const receipt = liquidityReceipt(plan);
    await expect(
      settleDefiExecution(context.db, "owner", action.id, token, {
        ...receipt,
        retiredPrincipalMicroUsd: "1",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(executionReceipts)).toHaveLength(0);
    expect(await attributedPrincipal(context.db, "owner", context.agentId)).toBe(20_000_000n);
    await settleDefiExecution(context.db, "owner", action.id, token, receipt);
    await settleDefiExecution(context.db, "owner", action.id, token, receipt);
    expect(await context.db.select().from(executionReceipts)).toHaveLength(1);
    expect(await context.db.select().from(defiDisposals)).toHaveLength(2);
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.defiPositions[0]).toMatchObject({
      kind: "lp_share",
      quantityUnits: 100n,
      principalMicroUsd: 3_000_000n,
    });
    expect(report.attributedPrincipalMicroUsd).toBe(20_000_000n);
    expect(report.realizedPnlMicroUsd).toBeNull();
    expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    await expect(
      availableInventory(context.db, "owner", "native_near", fixtureUsdc, Date.now()),
    ).rejects.toMatchObject({ code: "not_ready" });
    await nativeInventory(context.db, "8000");
    expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
    expect((await context.db.select().from(defiPositionClaims))[0]?.releasedAt).not.toBeNull();
    expect(
      (await readSpendingUsage(context.db, "owner", context.agentId, await databaseTime(context.db)))
        .userSpent24hMicroUsd,
    ).toBe(3_000_000n);
  });

  it("counts native actions and swaps under the same daily cap and receipt namespace", async () => {
    const plan = await liquidityPlan(context.db, context.agentId, { notionalMicroUsd: "10000000" });
    const action = await reserveDefiExecution(context.db, "owner", plan);
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
    const swap = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const usage = await readSpendingUsage(
      context.db,
      "owner",
      context.agentId,
      await databaseTime(context.db),
    );
    expect(usage.userPendingMicroUsd).toBe(20_000_000n);
    const token = await startAction(action.id);
    const receipt = liquidityReceipt(plan);
    await settleDefiExecution(context.db, "owner", action.id, token, receipt);
    await expect(
      recordExecutionFill(context.db, "owner", swap.id, "unused", {
        providerEventId: receipt.providerEventId,
        inputUnits: "1",
        outputUnits: "1",
        inputValueMicroUsd: "1",
        feeMicroUsd: "0",
        occurredAt: Date.now(),
      }),
    ).rejects.toThrow();
    await expect(
      recordExecutionFill(context.db, "owner", action.id, token, {
        providerEventId: "fake-swap",
        inputUnits: "1",
        outputUnits: "1",
        inputValueMicroUsd: "1",
        feeMicroUsd: "0",
        occurredAt: Date.now(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("binds venue permissions, signing bytes and revisions; cancellation releases every resource", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    const action = await reserveDefiExecution(context.db, "owner", plan);
    const { token } = await claimExecution(context.db, "owner", action.id);
    await expect(
      beginSubmission(context.db, "owner", action.id, token, {
        payloadHash: "d".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await revokeExecutionPermission(context.db, "owner", plan.permissionHash);
    await expect(
      beginSubmission(context.db, "owner", action.id, token, {
        payloadHash: "b".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    await cancelReservedExecution(context.db, "owner", action.id);
    expect((await context.db.select().from(positionReservations)).every((p) => p.heldUnits === 0n)).toBe(
      true,
    );
    expect((await context.db.select().from(defiPositionClaims))[0]?.releasedAt).not.toBeNull();
    await expect(
      confirmExecutionPermission(context.db, "stranger", permissionFixture(context.agentId)),
    ).rejects.toThrow();
    await expect(context.db.update(executionPermissions).set({ revokedAt: null })).rejects.toThrow();
    await expect(
      context.db.execute(sql`UPDATE execution_actions SET plan_json = '{}' WHERE id = ${action.id}`),
    ).rejects.toThrow();
    await expect(context.db.execute(sql`TRUNCATE execution_receipts CASCADE`)).rejects.toThrow();
  });

  it("keeps possibly sent actions reconciliation-only after revocation", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    const action = await reserveDefiExecution(context.db, "owner", plan);
    await startAction(action.id);
    await revokeExecutionPermission(context.db, "owner", plan.permissionHash);
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(and(eq(executionActions.userId, "owner"), eq(executionActions.id, action.id)));
    const claim = await claimExecution(context.db, "owner", action.id);
    expect(claim.mode).toBe("reconcile");
    await settleDefiExecution(context.db, "owner", action.id, claim.token, liquidityReceipt(plan));
    expect(await context.db.select().from(defiPositions)).toHaveLength(1);
  });
});
