import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";

interface PerformanceTotals {
  readonly total: string;
  readonly count: number;
  readonly unknown: number;
}
export interface DefiPerformanceTotal extends PerformanceTotals {
  readonly agentId: string;
}
export interface DefiPerformanceDay extends PerformanceTotals {
  readonly date: string;
}

function performanceRows(db: AppDatabase, owner: string, agentId?: string) {
  const plan = sql`${executionActions.planJson}::jsonb`,
    receipt = sql`${executionReceipts.receiptJson}::jsonb`;
  const collateral = sql`(SELECT p.value FROM jsonb_array_elements(${plan}->'positions') AS p(value) WHERE p.value->>'kind'='collateral')`;
  const after = sql`(SELECT p.value->>'afterUnits' FROM jsonb_array_elements(${receipt}->'positions') AS p(value) WHERE p.value->>'positionId'=${collateral}->>'positionId')`;
  // Immutable records are validated at settlement. Aggregate here instead of downloading every receipt.
  return db.$with("defi_performance_rows").as(
    db
      .select({
        agentId: executionActions.agentId,
        occurredAt: sql<number>`(${receipt}->>'occurredAt')::bigint`.as("occurred_at"),
        pnl: sql<string | null>`CASE WHEN ${plan}->>'scope'='hyperliquid'
      AND ${plan}->>'venueId'='hyperliquid' AND ${plan}->>'operation' IN ('perp_open','perp_reduce')
      AND jsonb_array_length(${receipt}->'cash')=1
      AND ${receipt}->'cash'->0->>'assetId' LIKE 'hyperliquid:usdc:%'
      THEN ((${receipt}->'cash'->0->>'creditUnits')::numeric - (${receipt}->'cash'->0->>'debitUnits')::numeric
        + (${after})::numeric - (${collateral}->>'beforeUnits')::numeric)::text ELSE NULL END`.as("pnl"),
      })
      .from(executionReceipts)
      .innerJoin(
        executionActions,
        and(
          eq(executionActions.id, executionReceipts.actionId),
          eq(executionActions.userId, executionReceipts.userId),
        ),
      )
      .where(
        and(
          eq(executionReceipts.userId, owner),
          eq(executionReceipts.kind, "defi"),
          agentId ? eq(executionActions.agentId, agentId) : undefined,
          sql`coalesce(${plan}->>'funding','false') <> 'true' AND ${plan}->>'operation' <> 'transfer'`,
        ),
      ),
  );
}

/** Capital transfers are excluded. Perps PnL uses reconciled cash plus the change in isolated collateral. */
export async function readDefiPerformance(
  db: AppDatabase,
  owner: string,
  agentId?: string,
): Promise<readonly DefiPerformanceTotal[]> {
  const rows = performanceRows(db, owner, agentId);
  return db
    .with(rows)
    .select({
      agentId: rows.agentId,
      total: sql<string>`coalesce(sum(${rows.pnl}::numeric),0)::text`,
      count: sql<number>`count(*)::int`,
      unknown: sql<number>`count(*) filter (where ${rows.pnl} is null)::int`,
    })
    .from(rows)
    .groupBy(rows.agentId);
}
export async function readDefiPerformanceDays(
  db: AppDatabase,
  owner: string,
  start: number,
  end: number,
): Promise<readonly DefiPerformanceDay[]> {
  const rows = performanceRows(db, owner);
  const day = sql<string>`to_char(to_timestamp(${rows.occurredAt}/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD')`;
  return db
    .with(rows)
    .select({
      date: day,
      total: sql<string>`coalesce(sum(${rows.pnl}::numeric),0)::text`,
      count: sql<number>`count(*)::int`,
      unknown: sql<number>`count(*) filter (where ${rows.pnl} is null)::int`,
    })
    .from(rows)
    .where(and(gte(rows.occurredAt, start), lt(rows.occurredAt, end)))
    .groupBy(day);
}
