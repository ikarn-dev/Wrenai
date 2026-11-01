import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import type { executionFills } from "@/server/db/execution-schema";
import {
  positionDisposals,
  positionLots,
  positionRealizations,
  positionReservations,
} from "@/server/db/position-schema";
import { ExecutionError, type ExecutionPlan } from "@/server/execution/contracts";
import type { ExecutionAction } from "@/server/execution/records";
import { consumeFifoLots, unreservedOwnedUnits } from "./lots";

export async function assertOwnedInput(db: AppDatabase, userId: string, plan: ExecutionPlan): Promise<void> {
  if (
    BigInt(plan.inputUnits) >
    (await unreservedOwnedUnits(db, userId, plan.agentId, plan.scope, plan.inputAssetId))
  ) {
    throw new ExecutionError("insufficient_funds", "This agent does not own enough unreserved input units.");
  }
}

export async function reserveOwnedInput(db: AppDatabase, action: ExecutionAction): Promise<void> {
  await db.insert(positionReservations).values({
    actionId: action.id,
    userId: action.userId,
    agentId: action.agentId,
    scope: action.scope,
    assetId: action.inputAssetId,
    initialUnits: action.inputUnits,
    heldUnits: action.inputUnits,
  });
}

export async function releaseOwnedInput(
  db: AppDatabase,
  userId: string,
  actionIds: readonly string[],
): Promise<void> {
  if (actionIds.length > 0) {
    await db
      .update(positionReservations)
      .set({ heldUnits: 0n })
      .where(and(eq(positionReservations.userId, userId), inArray(positionReservations.actionId, actionIds)));
  }
}

/** Applies only in the same owner transaction as the immutable fill insert. Exact receipt replay skips this call. */
export async function applyPositionFill(
  db: AppDatabase,
  action: ExecutionAction,
  fill: typeof executionFills.$inferSelect,
): Promise<void> {
  const [claim] = await db
    .select()
    .from(positionReservations)
    .where(and(eq(positionReservations.userId, action.userId), eq(positionReservations.actionId, action.id)))
    .limit(1);
  if (
    claim === undefined ||
    claim.agentId !== action.agentId ||
    claim.scope !== action.scope ||
    claim.assetId !== action.inputAssetId ||
    claim.heldUnits < fill.inputUnits
  ) {
    throw new ExecutionError(
      "not_ready",
      "This fill needs an attributed input reservation. Preserve legacy/unmatched actions for explicit reconciliation.",
    );
  }
  const consumed = await consumeFifoLots(
    db,
    action.userId,
    action.agentId,
    action.scope,
    action.inputAssetId,
    fill.inputUnits,
  );
  await db
    .update(positionReservations)
    .set({ heldUnits: claim.heldUnits - fill.inputUnits })
    .where(
      and(
        eq(positionReservations.actionId, action.id),
        eq(positionReservations.assetId, action.inputAssetId),
      ),
    );
  await db.insert(positionDisposals).values(
    consumed.entries.map((entry) => ({
      userId: action.userId,
      fillId: fill.id,
      lotId: entry.lotId,
      quantityUnits: entry.quantityUnits,
      basisMicroUsd: entry.basisMicroUsd,
      principalMicroUsd: entry.principalMicroUsd,
    })),
  );
  await db.insert(positionLots).values({
    id: randomUUID(),
    userId: action.userId,
    agentId: action.agentId,
    scope: action.scope,
    assetId: action.outputAssetId,
    sourceId: fill.id,
    sourceKind: "fill",
    initialUnits: fill.outputUnits,
    remainingUnits: fill.outputUnits,
    initialBasisMicroUsd: fill.outputValueMicroUsd,
    remainingBasisMicroUsd: fill.outputValueMicroUsd,
    initialPrincipalMicroUsd: consumed.principalMicroUsd,
    remainingPrincipalMicroUsd: consumed.principalMicroUsd,
    openedAt: fill.recordedAt,
  });
  // Received-value performance accounting expenses fees/slippage through verified net output value.
  // Do not add/subtract fee metadata again; missing valuations remain unknown.
  await db.insert(positionRealizations).values({
    fillId: fill.id,
    userId: action.userId,
    agentId: action.agentId,
    basisMicroUsd: consumed.basisMicroUsd,
    netProceedsMicroUsd: fill.outputValueMicroUsd,
    realizedPnlMicroUsd:
      consumed.basisMicroUsd === null || fill.outputValueMicroUsd === null
        ? null
        : fill.outputValueMicroUsd - consumed.basisMicroUsd,
    principalMicroUsd: consumed.principalMicroUsd,
    recordedAt: fill.recordedAt,
  });
}
