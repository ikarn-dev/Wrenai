import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./schema";

const time = (name: string) => bigint(name, { mode: "number" });
export const telegramConnections = pgTable(
  "telegram_connections",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    linkId: text("link_id").notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    firstName: text("first_name").notNull(),
    username: text("username"),
    linkedAt: time("linked_at").notNull(),
  },
  (t) => [
    uniqueIndex("telegram_connection_identity_idx").on(t.telegramUserId),
    uniqueIndex("telegram_connection_link_idx").on(t.linkId),
    check(
      "telegram_connection_private_chat",
      sql`${t.telegramUserId} = ${t.chatId} AND ${t.telegramUserId} ~ '^[1-9][0-9]{0,15}$'`,
    ),
  ],
).enableRLS();

export const telegramLinkChallenges = pgTable(
  "telegram_link_challenges",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    id: text("id").notNull(),
    tokenHash: text("token_hash").notNull(),
    botUsername: text("bot_username").notNull(),
    createdAt: time("created_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    claimedAt: time("claimed_at"),
    telegramUserId: text("telegram_user_id"),
    chatId: text("chat_id"),
    firstName: text("first_name"),
    username: text("username"),
  },
  (t) => [
    uniqueIndex("telegram_challenge_id_idx").on(t.id),
    uniqueIndex("telegram_challenge_token_idx").on(t.tokenHash),
    check("telegram_challenge_expiry_valid", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "telegram_challenge_claim_valid",
      sql`(${t.claimedAt} IS NULL AND ${t.telegramUserId} IS NULL AND ${t.chatId} IS NULL AND ${t.firstName} IS NULL AND ${t.username} IS NULL) OR (${t.claimedAt} IS NOT NULL AND ${t.telegramUserId} IS NOT NULL AND ${t.chatId} IS NOT NULL AND ${t.chatId} = ${t.telegramUserId} AND ${t.telegramUserId} ~ '^[1-9][0-9]{0,15}$' AND ${t.firstName} IS NOT NULL)`,
    ),
  ],
).enableRLS();
