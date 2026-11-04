import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./schema";

/**
 * Swaps paid straight from the user's wallet: the wallet signs one transaction to 1Click's deposit address and
 * 1Click delivers the output to the wallet. Wrenai never holds or signs for these funds; the row records the
 * reviewed quote, the wallet transaction and 1Click's final status.
 */
export const walletSwaps = pgTable(
  "wallet_swaps",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accountId: text("account_id").notNull(),
    quoteJson: text("quote_json").notNull(),
    depositAddress: text("deposit_address").notNull(),
    state: text("state", {
      enum: ["quoted", "signing", "submitted", "settled", "refunded", "failed", "cancelled"],
    }).notNull(),
    transactionHash: text("transaction_hash"),
    receivedUnits: text("received_units"),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("wallet_swap_deposit_idx").on(t.depositAddress),
    uniqueIndex("wallet_swap_transaction_idx").on(t.transactionHash),
    index("wallet_swap_owner_time_idx").on(t.userId, t.createdAt),
    check(
      "wallet_swap_state_valid",
      sql`${t.state} IN ('quoted','signing','submitted','settled','refunded','failed','cancelled')`,
    ),
    check(
      "wallet_swap_transaction_valid",
      sql`(${t.state} IN ('quoted','signing','cancelled') AND ${t.transactionHash} IS NULL) OR (${t.state} IN ('submitted','settled','refunded','failed') AND ${t.transactionHash} IS NOT NULL)`,
    ),
    check(
      "wallet_swap_size_valid",
      sql`length(${t.quoteJson}) <= 64000 AND ${t.expiresAt} > ${t.createdAt} AND ${t.updatedAt} >= ${t.createdAt}`,
    ),
  ],
).enableRLS();
