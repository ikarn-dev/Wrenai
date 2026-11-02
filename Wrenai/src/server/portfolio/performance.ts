import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionRealizations } from "@/server/db/position-schema";

export interface PerformanceValue {
  readonly agentId: string;
  readonly realizedPnlMicroUsd: bigint | null;
  readonly basisMicroUsd: bigint | null;
  readonly count: number;
  readonly unpriced: number;
}
export interface PortfolioPerformance {
  readonly agents: readonly PerformanceValue[];
  readonly days: readonly {
    readonly date: string;
    readonly pnlMicroUsd: bigint | null;
    readonly count: number;
  }[];
  readonly totalMicroUsd: bigint | null;
  readonly count: number;
  readonly unpriced: number;
}
export async function readPortfolioPerformance(
  db: AppDatabase,
  userId: string,
  now = Date.now(),
): Promise<PortfolioPerformance> {
  const date = new Date(now),
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const p = positionRealizations;
  const [totals, days, defi] = await Promise.all([
    db
      .select({
        agentId: p.agentId,
        total: sql<string>`coalesce(sum(${p.realizedPnlMicroUsd}), 0)::text`,
        basis: sql<string>`coalesce(sum(${p.basisMicroUsd}), 0)::text`,
        count: sql<number>`count(*)::int`,
        unknown: sql<number>`count(*) filter (where ${p.realizedPnlMicroUsd} is null)::int`,
      })
      .from(p)
      .where(eq(p.userId, userId))
      .groupBy(p.agentId),
    db
      .select({
        date: sql<string>`to_char(to_timestamp(${p.recordedAt} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
          "day",
        ),
        total: sql<string>`coalesce(sum(${p.realizedPnlMicroUsd}), 0)::text`,
        count: sql<number>`count(*)::int`,
        unknown: sql<number>`count(*) filter (where ${p.realizedPnlMicroUsd} is null)::int`,
      })
      .from(p)
      .where(and(eq(p.userId, userId), gte(p.recordedAt, start), lt(p.recordedAt, end)))
      .groupBy(sql`day`),
    db
      .select({
        agentId: executionActions.agentId,
        count: sql<number>`count(*)::int`,
        date: sql<string>`to_char(to_timestamp(${executionReceipts.recordedAt} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
          "day",
        ),
      })
      .from(executionReceipts)
      .innerJoin(executionActions, eq(executionActions.id, executionReceipts.actionId))
      .where(and(eq(executionReceipts.userId, userId), eq(executionReceipts.kind, "defi")))
      .groupBy(executionActions.agentId, sql`day`),
  ]);
  const agentIds = new Set([...totals.map((row) => row.agentId), ...defi.map((row) => row.agentId)]);
  const agents = [...agentIds].map((agentId): PerformanceValue => {
    const row = totals.find((value) => value.agentId === agentId),
      missing = defi
        .filter((value) => value.agentId === agentId)
        .reduce((sum, value) => sum + value.count, 0);
    const unpriced = (row?.unknown ?? 0) + missing,
      count = (row?.count ?? 0) + missing;
    return {
      agentId,
      realizedPnlMicroUsd: count > 0 && unpriced === 0 ? BigInt(row?.total ?? "0") : null,
      basisMicroUsd: count > 0 && unpriced === 0 ? BigInt(row?.basis ?? "0") : null,
      count,
      unpriced,
    };
  });
  const calendar = new Map(
    days.map((row) => [
      row.date,
      { date: row.date, pnlMicroUsd: row.unknown ? null : BigInt(row.total), count: row.count },
    ]),
  );
  for (const row of defi) {
    const at = Date.parse(`${row.date}T00:00:00Z`);
    if (at >= start && at < end) {
      const previous = calendar.get(row.date);
      calendar.set(row.date, {
        date: row.date,
        pnlMicroUsd: null,
        count: (previous?.count ?? 0) + row.count,
      });
    }
  }
  const count = agents.reduce((sum, row) => sum + row.count, 0),
    unpriced = agents.reduce((sum, row) => sum + row.unpriced, 0);
  return {
    agents,
    days: [...calendar.values()],
    count,
    unpriced,
    totalMicroUsd:
      count > 0 && unpriced === 0
        ? agents.reduce((sum, row) => sum + (row.realizedPnlMicroUsd ?? 0n), 0n)
        : null,
  };
}
