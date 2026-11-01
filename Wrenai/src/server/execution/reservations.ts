import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { assertOwnedInput, releaseOwnedInput, reserveOwnedInput } from "@/server/positions/execution";
import { parseUsd } from "@/shared/agents";
import { ExecutionError, executionPlanSchema } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { currentDefiPolicy } from "./defi-policy";
import { availableInventory } from "./inventory";
import { checkReservationLimits, currentExecutionPolicy } from "./policy";
import {
  databaseTime,
  type ExecutionAction,
  executionEvent,
  executionHash,
  invalidateInventory,
  ownedLedgerAction,
  swapAction,
} from "./records";

/** Internal persistence only. The future Executor must additionally validate quotes, finality, Guard and payloads. */
export async function reserveExecution(
  db: AppDatabase,
  userId: string,
  rawPlan: unknown,
): Promise<ExecutionAction> {
  const plan = executionPlanSchema.parse(rawPlan);
  const planHash = executionHash(plan);
  return userTransaction(db, userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(executionActions)
      .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, plan.requestId)))
      .limit(1);
    if (existing !== undefined) {
      if (existing.planHash !== planHash) {
        throw new ExecutionError("conflict", "This action request already belongs to a different plan.");
      }
      return swapAction(existing);
    }
    const now = await databaseTime(tx);
    if (plan.expiresAt <= now || plan.expiresAt > now + 5 * 60_000) {
      throw new ExecutionError(
        "not_ready",
        "The quote must be unexpired and valid for no more than five minutes.",
      );
    }
    const current = await currentExecutionPolicy(tx, userId, plan);
    const { policy, publicKey, policyHash } = current;
    await checkReservationLimits(tx, userId, plan, current, now);
    await assertOwnedInput(tx, userId, plan);
    if (
      BigInt(plan.inputUnits) > (await availableInventory(tx, userId, plan.scope, plan.inputAssetId, now))
    ) {
      throw new ExecutionError(
        "insufficient_funds",
        "The input funds are unavailable or reserved by another action.",
      );
    }
    const approved =
      policy.approvalMode === "autonomous" ||
      (policy.approvalMode === "above_size" &&
        BigInt(plan.notionalMicroUsd) <= parseUsd(policy.approvalThresholdUsd));
    const [action] = await tx
      .insert(executionActions)
      .values({
        id: randomUUID(),
        userId,
        agentId: plan.agentId,
        requestId: plan.requestId,
        planHash,
        planJson: JSON.stringify(plan),
        agentRevision: plan.agentRevision,
        strategyVersion: plan.strategyVersion,
        policyHash,
        scope: plan.scope,
        inputAssetId: plan.inputAssetId,
        outputAssetId: plan.outputAssetId,
        inputUnits: BigInt(plan.inputUnits),
        minOutputUnits: BigInt(plan.minOutputUnits),
        notionalMicroUsd: BigInt(plan.notionalMicroUsd),
        expiresAt: plan.expiresAt,
        status: "reserved",
        approvedAt: approved ? now : null,
        signingPublicKey: publicKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (action === undefined) {
      throw new Error("Execution reservation was not stored.");
    }
    const swap = swapAction(action);
    await reserveOwnedInput(tx, swap);
    await invalidateInventory(tx, userId, plan.scope);
    await executionEvent(tx, action, "reserved", now, {
      planHash,
      riskPolicyRevision: current.riskPolicy.revision,
      approval: approved ? "policy" : "required",
    });
    return swap;
  });
}

/** The caller must obtain userId from authenticated approval, never from model/provider input. */
export async function approveExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
  planHash: string,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    const now = await databaseTime(tx);
    if (action.status !== "reserved" || action.planHash !== planHash || action.expiresAt <= now) {
      throw new ExecutionError("conflict", "This approval does not match an active unexpired plan.");
    }
    const current =
      action.kind === "defi"
        ? await currentDefiPolicy(tx, userId, defiPlanSchema.parse(JSON.parse(action.planJson)), now)
        : await currentExecutionPolicy(
            tx,
            userId,
            executionPlanSchema.parse(JSON.parse(action.planJson)),
            action.signingPublicKey,
          );
    if (current.policyHash !== action.policyHash) {
      throw new ExecutionError("conflict", "The policy changed after this plan was created.");
    }
    if (action.approvedAt !== null) {
      return;
    }
    await tx
      .update(executionActions)
      .set({ approvedAt: now, updatedAt: now })
      .where(eq(executionActions.id, action.id));
    await executionEvent(tx, action, "approved", now, { planHash });
  });
}

export async function cancelReservedExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    if (action.status === "cancelled") {
      return;
    }
    if (action.status !== "reserved") {
      throw new ExecutionError(
        "conflict",
        "A possibly submitted action must be reconciled, not locally cancelled.",
      );
    }
    const now = await databaseTime(tx);
    await tx
      .update(executionActions)
      .set({
        status: "cancelled",
        reservationReleasedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(executionActions.id, action.id));
    await invalidateInventory(tx, userId, action.scope);
    await releaseOwnedInput(tx, userId, [action.id]);
    await tx
      .update(defiPositionClaims)
      .set({ releasedAt: now })
      .where(and(eq(defiPositionClaims.userId, userId), eq(defiPositionClaims.actionId, action.id)));
    await executionEvent(tx, action, "cancelled_before_submission", now);
  });
}
