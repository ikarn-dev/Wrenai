import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots, positionReservations } from "@/server/db/position-schema";
import { ExecutionError, type ExecutionScope } from "@/server/execution/contracts";
import { observedInventoryBalance } from "@/server/execution/inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";

/** Requires the owner lock for mutations; all scopes are actual provider locations, never wallet estimates. */
export async function manualAvailableUnits(
  db: AppDatabase,
  userId: string,
  subjectId: string,
  scope: ExecutionScope,
  assetId: string,
  now: number,
): Promise<bigint> {
  const balance = await observedInventoryBalance(db, userId, scope, assetId, now);
  const [other] = await db
    .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, userId),
        eq(positionLots.scope, scope),
        eq(positionLots.assetId, assetId),
        sql`${positionLots.agentId} <> ${subjectId}`,
      ),
    );
  const [held] = await db
    .select({ units: sql<string>`coalesce(sum(${positionReservations.heldUnits}), 0)::text` })
    .from(positionReservations)
    .where(
      and(
        eq(positionReservations.userId, userId),
        eq(positionReservations.agentId, subjectId),
        eq(positionReservations.scope, scope),
        eq(positionReservations.assetId, assetId),
      ),
    );
  const [legacy] = await db
    .select({ units: sql<string>`coalesce(sum(${executionActions.inputUnits}), 0)::text` })
    .from(executionActions)
    .leftJoin(positionReservations, eq(positionReservations.actionId, executionActions.id))
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.scope, scope),
        eq(executionActions.inputAssetId, assetId),
        isNull(executionActions.reservationReleasedAt),
        isNull(positionReservations.actionId),
      ),
    );
  const free =
    balance - BigInt(other?.units ?? "0") - BigInt(held?.units ?? "0") - BigInt(legacy?.units ?? "0");
  return free > 0n ? free : 0n;
}
export async function adoptManualInput(
  db: AppDatabase,
  userId: string,
  subjectId: string,
  scope: ExecutionScope,
  assetId: string,
  quantity: bigint,
  basis: bigint | null,
  now: number,
): Promise<void> {
  if (quantity === 0n) {
    return;
  }
  if (quantity > (await manualAvailableUnits(db, userId, subjectId, scope, assetId, now))) {
    // Usually the balance is simply short: wallet funds don't count, only the venue balance (for Private swaps,
    // the NEAR Intents private balance, where NEAR is held as wNEAR). Funds an agent holds don't count either.
    throw new ExecutionError(
      "insufficient_funds",
      scope === "confidential"
        ? "Not enough in your NEAR Intents private balance for this swap. Funds in your wallet aren't in it yet."
        : "Not enough free balance for this trade. Funds held by agents aren't available.",
    );
  }
  const owned = await unreservedOwnedUnits(db, userId, subjectId, scope, assetId);
  const missing = quantity - owned;
  if (missing <= 0n) {
    return;
  }
  const id = randomUUID(),
    cost = basis === null ? null : (basis * missing + quantity - 1n) / quantity;
  await db.insert(positionLots).values({
    id,
    userId,
    agentId: subjectId,
    scope,
    assetId,
    sourceId: id,
    sourceKind: "allocation",
    initialUnits: missing,
    remainingUnits: missing,
    initialBasisMicroUsd: cost,
    remainingBasisMicroUsd: cost,
    initialPrincipalMicroUsd: 0n,
    remainingPrincipalMicroUsd: 0n,
    openedAt: now,
  });
}
