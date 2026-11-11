import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { executionActions } from "./execution-schema";
import { executionSubjects } from "./subject-schema";

export const manualTrades = pgTable(
  "manual_trades",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    subjectId: text("subject_id").notNull(),
    requestId: text("request_id").notNull(),
    intentHash: text("intent_hash").notNull(),
    intentJson: text("intent_json").notNull(),
    previewJson: text("preview_json").notNull(),
    bindingHash: text("binding_hash").notNull(),
    source: text("source", { enum: ["jarvis", "spot", "perps", "portfolio"] }).notNull(),
    status: text("status", { enum: ["quoted", "confirmed", "cancelled", "expired"] }).notNull(),
    revision: integer("revision").notNull().default(1),
    actionId: text("action_id"),
    confirmedAt: bigint("confirmed_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.subjectId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    uniqueIndex("manual_trade_owner_request_idx").on(t.userId, t.requestId),
    uniqueIndex("manual_trade_action_idx").on(t.actionId),
    index("manual_trade_owner_time_idx").on(t.userId, t.createdAt),
    check(
      "manual_trade_status_valid",
      sql`${t.status} IN ('quoted', 'confirmed', 'cancelled', 'expired') AND ${t.revision} > 0`,
    ),
    check(
      "manual_trade_confirmation_valid",
      sql`(${t.status} = 'confirmed' AND ${t.confirmedAt} IS NOT NULL AND ${t.actionId} IS NOT NULL) OR (${t.status} <> 'confirmed' AND ${t.confirmedAt} IS NULL AND ${t.actionId} IS NULL)`,
    ),
    check(
      "manual_trade_size_valid",
      sql`length(${t.intentJson}) <= 12000 AND length(${t.previewJson}) <= 64000 AND ${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
).enableRLS();
