import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { parseUsd } from "@/shared/agents";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { currentDefiPolicy } from "./defi-policy";
import { availableInventory, observedInventoryBalance } from "./inventory";
import {
  databaseTime,
  executionEvent,
  executionHash,
  invalidateInventory,
  type LedgerAction,
} from "./records";

/** Internal, after exact payload/quote verification. No external requests occur while reservations are locked. */
export async function reserveDefiExecution(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<LedgerAction> {
  const plan = defiPlanSchema.parse(raw);
  const planHash = executionHash(plan);
  return userTransaction(db, userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(executionActions)
      .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, plan.requestId)))
      .limit(1);
    if (existing !== undefined) {
      if (existing.kind !== "defi" || existing.planHash !== planHash) {
        throw new ExecutionError("conflict", "This request already belongs to another execution plan.");
      }
      return existing;
    }
    const now = await databaseTime(tx);
    const current = await currentDefiPolicy(tx, userId, plan, now);
    for (const asset of plan.cash) {
      await observedInventoryBalance(tx, userId, plan.scope, asset.assetId, now);
    }
    const debits = plan.cash.filter((a) => BigInt(a.maxDebitUnits) > 0n);
    for (const asset of debits) {
      const quantity = BigInt(asset.maxDebitUnits);
      if (
        quantity > (await unreservedOwnedUnits(tx, userId, plan.agentId, plan.scope, asset.assetId)) ||
        quantity > (await availableInventory(tx, userId, plan.scope, asset.assetId, now))
      ) {
        throw new ExecutionError(
          "insufficient_funds",
          "Every input asset must be owned, fresh and unreserved.",
        );
      }
    }
    const approved =
      current.policy.approvalMode === "autonomous" ||
      (current.policy.approvalMode === "above_size" &&
        BigInt(plan.notionalMicroUsd) <= parseUsd(current.policy.approvalThresholdUsd));
    const [action] = await tx
      .insert(executionActions)
      .values({
        id: randomUUID(),
        userId,
        agentId: plan.agentId,
        requestId: plan.requestId,
        planHash,
        planJson: JSON.stringify(plan),
        kind: "defi",
        agentRevision: plan.agentRevision,
        strategyVersion: plan.strategyVersion,
        policyHash: current.policyHash,
        scope: plan.scope,
        notionalMicroUsd: BigInt(plan.notionalMicroUsd),
        capitalReservationMicroUsd: plan.operation === "borrow" ? BigInt(plan.notionalMicroUsd) : 0n,
        expiresAt: plan.expiresAt,
        status: "reserved",
        approvedAt: approved ? now : null,
        signingPublicKey: current.publicKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!action) {
      throw new Error("The DeFi reservation was not stored.");
    }
    if (debits.length > 0) {
      await tx.insert(positionReservations).values(
        debits.map((asset) => ({
          userId,
          agentId: plan.agentId,
          scope: plan.scope,
          actionId: action.id,
          assetId: asset.assetId,
          initialUnits: BigInt(asset.maxDebitUnits),
          heldUnits: BigInt(asset.maxDebitUnits),
        })),
      );
    }
    if (plan.positions.length > 0) {
      await tx.insert(defiPositionClaims).values(
        plan.positions.map((p) => ({
          userId,
          scope: plan.scope,
          actionId: action.id,
          positionId: p.positionId,
          venueId: plan.venueId,
          kind: p.kind,
          instrumentId: p.instrumentId,
        })),
      );
    }
    await invalidateInventory(tx, userId, plan.scope);
    await executionEvent(tx, action, "reserved", now, {
      planHash,
      operation: plan.operation,
      permissionHash: plan.permissionHash,
      approval: approved ? "policy" : "required",
    });
    return action;
  });
}
