import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { executionSubjects } from "./subject-schema";

export const nativeDeposits = pgTable(
  "native_deposits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    subjectId: text("subject_id").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    state: text("state", {
      enum: ["prepared", "gas_pending", "gas_confirmed", "token_pending", "complete", "cancelled"],
    }).notNull(),
    gasHash: text("gas_hash"),
    tokenHash: text("token_hash"),
    attemptedAt: bigint("attempted_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.subjectId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    uniqueIndex("native_deposit_gas_hash_idx").on(t.gasHash),
    uniqueIndex("native_deposit_token_hash_idx").on(t.tokenHash),
    uniqueIndex("native_deposit_active_owner_idx")
      .on(t.userId)
      .where(sql`${t.state} NOT IN ('complete', 'cancelled')`),
    check(
      "native_deposit_state_valid",
      sql`${t.state} IN ('prepared', 'gas_pending', 'gas_confirmed', 'token_pending', 'complete', 'cancelled')`,
    ),
    check(
      "native_deposit_complete_valid",
      sql`(${t.state} = 'complete' AND ${t.completedAt} IS NOT NULL AND ${t.tokenHash} IS NOT NULL AND ${t.gasHash} IS NOT NULL) OR (${t.state} <> 'complete' AND ${t.completedAt} IS NULL)`,
    ),
  ],
).enableRLS();
