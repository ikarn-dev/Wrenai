import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { executionActions } from "./execution-schema";
import { tradingAccounts } from "./trading-account-schema";

export const nativeSubmissions = pgTable(
  "native_submissions",
  {
    actionId: text("action_id").notNull(),
    role: text("role", { enum: ["registration", "swap"] }).notNull(),
    userId: text("user_id").notNull(),
    rootId: text("root_id").notNull(),
    accountId: text("account_id").notNull(),
    publicKey: text("public_key").notNull(),
    nonce: numeric("nonce", { precision: 20, scale: 0, mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    sealedTransaction: text("sealed_transaction").notNull(),
    maximumGasUnits: numeric("maximum_gas_units", { precision: 78, scale: 0, mode: "bigint" }).notNull(),
    spentGasUnits: numeric("spent_gas_units", { precision: 78, scale: 0, mode: "bigint" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    finalizedAt: bigint("finalized_at", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.actionId, t.role] }),
    check("native_submission_role_valid", sql`${t.role} IN ('registration', 'swap')`),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    foreignKey({
      columns: [t.userId, t.rootId],
      foreignColumns: [tradingAccounts.userId, tradingAccounts.id],
    }),
    uniqueIndex("native_submission_nonce_idx").on(t.rootId, t.nonce),
    uniqueIndex("native_submission_hash_idx").on(t.transactionHash),
    uniqueIndex("native_submission_outstanding_idx").on(t.rootId).where(sql`${t.finalizedAt} IS NULL`),
    check(
      "native_submission_amounts_valid",
      sql`${t.nonce} > 0 AND ${t.maximumGasUnits} > 0 AND (${t.spentGasUnits} IS NULL OR ${t.spentGasUnits} >= 0)`,
    ),
  ],
).enableRLS();
