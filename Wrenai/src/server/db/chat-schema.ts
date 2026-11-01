import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

const time = (name: string) => bigint(name, { mode: "number" });

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sealedTitle: text("sealed_title"),
    deletedAt: time("deleted_at"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    uniqueIndex("chat_owner_id_idx").on(t.userId, t.id),
    index("chat_owner_updated_idx").on(t.userId, t.updatedAt),
    check("chat_title_live_valid", sql`(${t.deletedAt} IS NULL) = (${t.sealedTitle} IS NOT NULL)`),
    check("chat_revision_valid", sql`${t.revision} > 0`),
  ],
).enableRLS();

export const chatAgentDrafts = pgTable(
  "chat_agent_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: ["chat", "manual"] })
      .notNull()
      .default("chat"),
    conversationId: text("conversation_id"),
    turnId: text("turn_id"),
    tool: text("tool").notNull(),
    sealedDraft: text("sealed_draft").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("chat_draft_source_idx").on(t.userId, t.turnId, t.tool),
    index("chat_draft_owner_idx").on(t.userId),
    check(
      "chat_draft_source_valid",
      sql`(${t.sourceType} = 'chat' AND ${t.conversationId} IS NOT NULL AND ${t.turnId} IS NOT NULL) OR (${t.sourceType} = 'manual' AND ${t.conversationId} IS NULL AND ${t.turnId} IS NULL)`,
    ),
  ],
).enableRLS();

export const chatTurns = pgTable(
  "chat_turns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sequence: integer("sequence").notNull(),
    inputHash: text("input_hash").notNull(),
    sealedMessage: text("sealed_message").notNull(),
    sealedReply: text("sealed_reply"),
    includeContext: boolean("include_context").notNull(),
    state: text("state", { enum: ["pending", "complete", "failed", "cancelled"] }).notNull(),
    leaseToken: text("lease_token").notNull(),
    leaseExpiresAt: time("lease_expires_at").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.conversationId],
      foreignColumns: [chatConversations.userId, chatConversations.id],
    }).onDelete("cascade"),
    uniqueIndex("chat_turn_sequence_idx").on(t.conversationId, t.sequence),
    index("chat_turn_owner_idx").on(t.userId, t.conversationId),
    check("chat_turn_sequence_valid", sql`${t.sequence} > 0 AND ${t.sequence} <= 100`),
    check("chat_turn_state_valid", sql`${t.state} IN ('pending', 'complete', 'failed', 'cancelled')`),
    check("chat_turn_reply_valid", sql`(${t.state} = 'complete') = (${t.sealedReply} IS NOT NULL)`),
    check("chat_turn_hash_valid", sql`${t.inputHash} ~ '^[a-f0-9]{64}$'`),
  ],
).enableRLS();
