import { sql } from "drizzle-orm";
import { bigint, check, integer, numeric, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { MAX_TOKEN_UNITS } from "@/shared/token-units";
import { users } from "./schema";

// Append-only versions: the latest owner revision is authoritative; there are no implicit defaults.
export const userRiskPolicies = pgTable(
  "user_risk_policies",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    revision: integer("revision").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    policyHash: text("policy_hash").notNull(),
    policyJson: text("policy_json").notNull(),
    dailyCapMicroUsd: numeric("daily_cap_micro_usd", { precision: 78, scale: 0, mode: "bigint" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.revision] }),
    uniqueIndex("risk_policy_owner_request_idx").on(t.userId, t.requestId),
    check("risk_policy_revision_valid", sql`${t.revision} > 0`),
    check(
      "risk_policy_daily_cap_valid",
      sql`${t.dailyCapMicroUsd} > 0 AND ${t.dailyCapMicroUsd} <= ${sql.raw(MAX_TOKEN_UNITS.toString())}`,
    ),
    check(
      "risk_policy_hash_valid",
      sql`${t.policyHash} ~ '^[a-f0-9]{64}$' AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
).enableRLS();
