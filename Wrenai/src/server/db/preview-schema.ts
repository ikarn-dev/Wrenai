import { bigint, foreignKey, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agent-schema";
import { users } from "./schema";

export const tradePreviews = pgTable(
  "trade_previews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    riskPolicyRevision: integer("risk_policy_revision").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("preview_owner_request_idx").on(table.userId, table.requestId),
    index("preview_agent_time_idx").on(table.userId, table.agentId, table.createdAt),
    foreignKey({ columns: [table.userId, table.agentId], foreignColumns: [agents.userId, agents.id] }),
  ],
).enableRLS();

export const intentsSessions = pgTable("intents_sessions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  sealedTokens: text("sealed_tokens").notNull(),
  accessExpiresAt: bigint("access_expires_at", { mode: "number" }).notNull(),
  refreshExpiresAt: bigint("refresh_expires_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}).enableRLS();
