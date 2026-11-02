import "server-only";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { positionLots, positionReservations } from "@/server/db/position-schema";
import { ExecutionError, type ExecutionScope } from "@/server/execution/contracts";
import { minimumUnits } from "@/shared/token-units";
import type { ConsumedLots, LotDisposal } from "./contracts";

export async function unreservedOwnedUnits(
  db: AppDatabase,
  userId: string,
  agentId: string,
  scope: ExecutionScope,
  assetId: string,
  excludeActionId?: string,
): Promise<bigint> {
  const [owned] = await db
    .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, userId),
        eq(positionLots.agentId, agentId),
        eq(positionLots.scope, scope),
        eq(positionLots.assetId, assetId),
      ),
    );
  const [held] = await db
    .select({ units: sql<string>`coalesce(sum(${positionReservations.heldUnits}), 0)::text` })
    .from(positionReservations)
    .where(
      and(
        eq(positionReservations.userId, userId),
        eq(positionReservations.agentId, agentId),
        eq(positionReservations.scope, scope),
        eq(positionReservations.assetId, assetId),
        excludeActionId ? sql`${positionReservations.actionId} <> ${excludeActionId}` : undefined,
      ),
    );
  return BigInt(owned?.units ?? "0") - BigInt(held?.units ?? "0");
}

/** Allocate rounding dust to the earlier disposal, reducing reported profit until the final remainder closes. */
export function proportionalCost(cost: bigint, quantity: bigint, total: bigint): bigint {
  if (cost < 0n || quantity <= 0n || total < quantity) {
    throw new RangeError("Invalid FIFO proportion.");
  }
  return (cost * quantity + total - 1n) / total;
}

/** Requires the caller's owner transaction. Receipt order determines FIFO, not untrusted provider timestamps. */
export async function previewFifoLots(
  db: AppDatabase,
  userId: string,
  agentId: string,
  scope: ExecutionScope,
  assetId: string,
  quantity: bigint,
): Promise<ConsumedLots> {
  const lots = await db
    .select()
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, userId),
        eq(positionLots.agentId, agentId),
        eq(positionLots.scope, scope),
        eq(positionLots.assetId, assetId),
        gt(positionLots.remainingUnits, 0n),
      ),
    )
    .orderBy(asc(positionLots.sequence));
  let remaining = quantity;
  let basis: bigint | null = 0n;
  let principal = 0n;
  const entries: LotDisposal[] = [];
  for (const lot of lots) {
    if (remaining === 0n) {
      break;
    }
    const take = minimumUnits(remaining, lot.remainingUnits);
    const cost =
      lot.remainingBasisMicroUsd === null
        ? null
        : proportionalCost(lot.remainingBasisMicroUsd, take, lot.remainingUnits);
    const capital = proportionalCost(lot.remainingPrincipalMicroUsd, take, lot.remainingUnits);
    entries.push({ lotId: lot.id, quantityUnits: take, basisMicroUsd: cost, principalMicroUsd: capital });
    basis = basis === null || cost === null ? null : basis + cost;
    principal += capital;
    remaining -= take;
  }
  if (remaining !== 0n) {
    throw new ExecutionError(
      "insufficient_funds",
      "The agent does not own enough units to account for this disposal.",
    );
  }
  return { entries, basisMicroUsd: basis, principalMicroUsd: principal };
}

/** Requires the same owner lock as the preview so no allocation can change between planning and applying FIFO. */
export async function consumeFifoLots(
  db: AppDatabase,
  userId: string,
  agentId: string,
  scope: ExecutionScope,
  assetId: string,
  quantity: bigint,
): Promise<ConsumedLots> {
  const result = await previewFifoLots(db, userId, agentId, scope, assetId, quantity);
  for (const entry of result.entries) {
    await db
      .update(positionLots)
      .set({
        remainingUnits: sql`${positionLots.remainingUnits} - ${entry.quantityUnits}`,
        remainingBasisMicroUsd:
          entry.basisMicroUsd === null
            ? null
            : sql`${positionLots.remainingBasisMicroUsd} - ${entry.basisMicroUsd}`,
        remainingPrincipalMicroUsd: sql`${positionLots.remainingPrincipalMicroUsd} - ${entry.principalMicroUsd}`,
      })
      .where(eq(positionLots.id, entry.lotId));
  }
  return result;
}
