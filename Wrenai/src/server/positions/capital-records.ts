import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions, executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { agentCapital, capitalEvents, positionLots } from "@/server/db/position-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { executionHash } from "@/server/execution/records";

export type CapitalKind = typeof capitalEvents.$inferInsert.kind;

export async function repeatedCapitalRequest(
  db: AppDatabase,
  userId: string,
  requestId: string,
  kind: CapitalKind,
  input: unknown,
): Promise<string | undefined> {
  const [event] = await db
    .select()
    .from(capitalEvents)
    .where(and(eq(capitalEvents.userId, userId), eq(capitalEvents.requestId, requestId)))
    .limit(1);
  if (event !== undefined && event.inputHash !== executionHash({ kind, input })) {
    throw new ExecutionError("conflict", "This capital request already belongs to another operation.");
  }
  return event?.resourceId;
}

export async function recordCapitalEvent(
  db: AppDatabase,
  userId: string,
  agentId: string | null,
  requestId: string,
  kind: CapitalKind,
  input: unknown,
  resourceId: string,
  now: number,
  detail: unknown = input,
): Promise<void> {
  await db.insert(capitalEvents).values({
    id: randomUUID(),
    userId,
    agentId,
    requestId,
    kind,
    inputHash: executionHash({ kind, input }),
    resourceId,
    detailJson: JSON.stringify(detail),
    recordedAt: now,
  });
}

export async function attributedPrincipal(db: AppDatabase, userId: string, agentId: string): Promise<bigint> {
  const [row] = await db
    .select({ amount: sql<string>`coalesce(sum(${positionLots.remainingPrincipalMicroUsd}), 0)::text` })
    .from(positionLots)
    .where(and(eq(positionLots.userId, userId), eq(positionLots.agentId, agentId)));
  const [positions] = await db
    .select({ amount: sql<string>`coalesce(sum(${defiPositions.principalMicroUsd}), 0)::text` })
    .from(defiPositions)
    .where(and(eq(defiPositions.userId, userId), eq(defiPositions.agentId, agentId)));
  return BigInt(row?.amount ?? "0") + BigInt(positions?.amount ?? "0");
}

/** Existing attributed principal plus unresolved borrowing commitments; call under the owner lock. */
export async function committedCapital(
  db: AppDatabase,
  userId: string,
  agentId: string,
  excludeActionId?: string,
): Promise<bigint> {
  const pending = db
    .select({
      amount:
        sql`${executionActions.capitalReservationMicroUsd} - coalesce(sum(${executionReceipts.borrowedCapitalMicroUsd}), 0)`.as(
          "pending_capital",
        ),
    })
    .from(executionActions)
    .leftJoin(executionReceipts, eq(executionReceipts.actionId, executionActions.id))
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        isNull(executionActions.reservationReleasedAt),
        excludeActionId === undefined ? undefined : ne(executionActions.id, excludeActionId),
      ),
    )
    .groupBy(executionActions.id)
    .as("capital_claims");
  const [row] = await db
    .select({
      amount: sql<string>`coalesce(sum(${pending.amount}), 0)::text`,
      invalid: sql<boolean>`coalesce(bool_or(${pending.amount} < 0), false)`,
    })
    .from(pending);
  if (row?.invalid) {
    throw new ExecutionError("conflict", "Recorded borrowing exceeds a committed capital ceiling.");
  }
  return (await attributedPrincipal(db, userId, agentId)) + BigInt(row?.amount ?? "0");
}

export async function allocationCeiling(db: AppDatabase, userId: string, agentId: string): Promise<bigint> {
  const [allocation] = await db
    .select()
    .from(agentCapital)
    .where(and(eq(agentCapital.userId, userId), eq(agentCapital.agentId, agentId)))
    .limit(1);
  if (allocation === undefined) {
    throw new ExecutionError(
      "not_ready",
      "Assign this agent a capital ceiling before allocating assets or reserving trades.",
    );
  }
  return allocation.limitMicroUsd;
}

export async function assignedCapitalLimit(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<bigint> {
  const [allocation] = await db
    .select()
    .from(agentCapital)
    .where(and(eq(agentCapital.userId, userId), eq(agentCapital.agentId, agentId)))
    .limit(1);
  return allocation?.limitMicroUsd ?? 0n;
}
