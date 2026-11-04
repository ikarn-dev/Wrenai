import { sql } from "drizzle-orm";
import { bigint, check, index, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { users } from "./schema";

export const portfolioObservations = pgTable(
  "portfolio_observations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    bucket: bigint("bucket", { mode: "number" }).notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    valueMicroUsd: numeric("value_micro_usd", { precision: 78, scale: 0, mode: "bigint" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bucket] }),
    index("portfolio_observation_time_idx").on(t.userId, t.observedAt),
    check(
      "portfolio_observation_bucket_valid",
      sql`${t.bucket} >= 0 AND ${t.observedAt} >= ${t.bucket} AND ${t.observedAt} < ${t.bucket}+300000 AND mod(${t.bucket},300000)=0`,
    ),
  ],
).enableRLS();
