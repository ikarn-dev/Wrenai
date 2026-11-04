import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./schema";
import { executionSubjects } from "./subject-schema";

const time = (name: string) => bigint(name, { mode: "number" });
export const tradingAccounts = pgTable(
  "trading_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    nativePublicKey: text("native_public_key").notNull().unique(),
    nativeAccountId: text("native_account_id").notNull().unique(),
    perpAddress: text("perp_address").notNull().unique(),
    sealedKeys: text("sealed_keys"),
    backupConfirmedAt: time("backup_confirmed_at"),
    backupFileHash: text("backup_file_hash"),
    backupVersion: integer("backup_version").notNull().default(1),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    index("trading_account_owner_idx").on(t.userId),
    uniqueIndex("trading_account_owner_id_idx").on(t.userId, t.id),
    uniqueIndex("trading_account_active_owner_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    check("trading_account_backup_version_valid", sql`${t.backupVersion} IN (1, 2)`),
    check(
      "trading_account_keys_valid",
      sql`(${t.revokedAt} IS NULL AND ${t.sealedKeys} IS NOT NULL) OR (${t.revokedAt} IS NOT NULL AND ${t.sealedKeys} IS NULL)`,
    ),
    check(
      "trading_account_backup_valid",
      sql`(${t.backupConfirmedAt} IS NULL AND ${t.backupFileHash} IS NULL) OR (${t.backupConfirmedAt} IS NOT NULL AND ${t.backupFileHash} IS NOT NULL AND ${t.backupFileHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      "trading_account_identities_valid",
      sql`${t.nativeAccountId} ~ '^[a-f0-9]{64}$' AND ${t.nativePublicKey} ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]+$' AND ${t.perpAddress} ~ '^0x[a-fA-F0-9]{40}$'`,
    ),
  ],
).enableRLS();

// Addresses are derived after creation/backup; no additional secret or venue sub-account is stored.
export const agentTradingAccounts = pgTable(
  "agent_trading_accounts",
  {
    agentId: text("agent_id").primaryKey(),
    userId: text("user_id").notNull(),
    rootId: text("root_id").notNull(),
    derivationIndex: integer("derivation_index").notNull(),
    perpAddress: text("perp_address").notNull(),
    lastNonce: time("last_nonce").notNull().default(0),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    foreignKey({
      columns: [t.userId, t.rootId],
      foreignColumns: [tradingAccounts.userId, tradingAccounts.id],
    }),
    uniqueIndex("agent_trading_derivation_idx").on(t.rootId, t.derivationIndex),
    uniqueIndex("agent_trading_address_idx").on(t.perpAddress),
    check(
      "agent_trading_derivation_valid",
      sql`${t.derivationIndex} >= 0 AND ${t.derivationIndex} < 1000 AND ${t.lastNonce} >= 0 AND ${t.perpAddress} ~ '^0x[a-fA-F0-9]{40}$'`,
    ),
  ],
).enableRLS();
