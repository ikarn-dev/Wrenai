import "server-only";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { ExecutionError } from "./contracts";

interface SpendingUsage {
  readonly userSpent24hMicroUsd: bigint;
  readonly agentSpent24hMicroUsd: bigint;
  readonly userPendingMicroUsd: bigint;
  readonly agentPendingMicroUsd: bigint;
}

/** Read under the owner's mutation lock, with database time. Both account scopes share the same caps. */
export async function readSpendingUsage(
  db: AppDatabase,
  userId: string,
  agentId: string,
  now: number,
  excludeActionId?: string,
): Promise<SpendingUsage> {
  // Subtract all recorded debits from each held ceiling, including receipts outside the rolling window.
  const remaining = db
    .select({
      agentId: executionActions.agentId,
      amount:
        sql`${executionActions.notionalMicroUsd} - coalesce(sum(${executionReceipts.riskDebitMicroUsd}), 0)`.as(
          "remaining_amount",
        ),
    })
    .from(executionActions)
    .leftJoin(executionReceipts, eq(executionReceipts.actionId, executionActions.id))
    .where(
      and(
        eq(executionActions.userId, userId),
        sql`coalesce(${executionActions.planJson}::jsonb ->> 'reduceOnly', 'false') <> 'true'`,
        sql`coalesce(${executionActions.planJson}::jsonb ->> 'funding', 'false') <> 'true'`,
        isNull(executionActions.reservationReleasedAt),
        excludeActionId === undefined ? undefined : ne(executionActions.id, excludeActionId),
      ),
    )
    .groupBy(executionActions.id)
    .as("remaining");
  const [pending] = await db
    .select({
      user: sql<string>`coalesce(sum(${remaining.amount}), 0)::text`,
      agent: sql<string>`coalesce(sum(${remaining.amount}) filter (where ${remaining.agentId} = ${agentId}), 0)::text`,
      invalid: sql<boolean>`coalesce(bool_or(${remaining.amount} < 0), false)`,
    })
    .from(remaining);
  if (pending?.invalid) {
    throw new ExecutionError(
      "conflict",
      "Recorded debits exceed a held risk ceiling. Reconcile before new spending.",
    );
  }
  const [spent] = await db
    .select({
      user: sql<string>`coalesce(sum(${executionReceipts.riskDebitMicroUsd}), 0)::text`,
      agent: sql<string>`coalesce(sum(${executionReceipts.riskDebitMicroUsd}) filter (where ${executionActions.agentId} = ${agentId}), 0)::text`,
    })
    .from(executionReceipts)
    .innerJoin(executionActions, eq(executionActions.id, executionReceipts.actionId))
    .where(
      and(
        eq(executionReceipts.userId, userId),
        gte(executionReceipts.recordedAt, now - 86_400_000),
        sql`coalesce(${executionActions.planJson}::jsonb ->> 'reduceOnly', 'false') <> 'true'`,
        sql`coalesce(${executionActions.planJson}::jsonb ->> 'funding', 'false') <> 'true'`,
      ),
    );
  return {
    userSpent24hMicroUsd: BigInt(spent?.user ?? "0"),
    agentSpent24hMicroUsd: BigInt(spent?.agent ?? "0"),
    userPendingMicroUsd: BigInt(pending?.user ?? "0"),
    agentPendingMicroUsd: BigInt(pending?.agent ?? "0"),
  };
}

/** A possibly submitted action counts once, regardless of the number of fills or retries. */
export async function readSubmissionUsage(
  db: AppDatabase,
  userId: string,
  agentId: string,
  now: number,
): Promise<{ readonly submissionsLastHour: bigint; readonly lastSubmissionAt: bigint | null }> {
  const [row] = await db
    .select({
      count: sql<string>`count(*) filter (where ${executionActions.startedAt} >= ${now - 3_600_000})::text`,
      last: sql<string | null>`max(${executionActions.startedAt})::text`,
    })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        gte(executionActions.startedAt, now - 86_400_000),
        sql`coalesce(${executionActions.planJson}::jsonb ->> 'funding', 'false') <> 'true'`,
      ),
    );
  return {
    submissionsLastHour: BigInt(row?.count ?? "0"),
    lastSubmissionAt: row?.last === null || row?.last === undefined ? null : BigInt(row.last),
  };
}
