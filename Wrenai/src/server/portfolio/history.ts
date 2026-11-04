import "server-only";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { portfolioObservations } from "@/server/db/portfolio-schema";
import type { PortfolioValuation } from "./valuation";

export interface PortfolioHistoryPoint {
  readonly at: number;
  readonly valueMicroUsd: bigint | null;
}
/** Observed values only: missing prices and pending transfers create gaps; never backfill invented history. */
export async function recordPortfolioHistory(
  db: AppDatabase,
  owner: string,
  value: PortfolioValuation,
): Promise<readonly PortfolioHistoryPoint[]> {
  const bucket = Math.floor(value.observedAt / 300000) * 300000;
  await db
    .insert(portfolioObservations)
    .values({
      userId: owner,
      bucket,
      observedAt: value.observedAt,
      valueMicroUsd: value.settling ? null : value.totalMicroUsd,
    })
    .onConflictDoUpdate({
      target: [portfolioObservations.userId, portfolioObservations.bucket],
      set: { observedAt: value.observedAt, valueMicroUsd: value.settling ? null : value.totalMicroUsd },
      setWhere: lte(portfolioObservations.observedAt, value.observedAt),
    });
  const rows = await db
    .select({ at: portfolioObservations.observedAt, valueMicroUsd: portfolioObservations.valueMicroUsd })
    .from(portfolioObservations)
    .where(
      and(
        eq(portfolioObservations.userId, owner),
        gte(portfolioObservations.observedAt, value.observedAt - 30 * 86400000),
      ),
    )
    .orderBy(desc(portfolioObservations.observedAt))
    .limit(120);
  return rows.toReversed();
}
