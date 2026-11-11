import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agent-schema";
import { executionActions } from "./execution-schema";

export const walletFundings = pgTable(
  "wallet_fundings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    inputHash: text("input_hash").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    state: text("state", {
      enum: ["prepared", "wallet_pending", "deposited", "converting", "complete", "abandoned"],
    }).notNull(),
    transactionHash: text("transaction_hash"),
    actionId: text("action_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    walletAttemptAt: bigint("wallet_attempt_at", { mode: "number" }),
    confirmedAt: bigint("confirmed_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.agentId], foreignColumns: [agents.userId, agents.id] }),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    uniqueIndex("wallet_funding_transaction_idx").on(t.transactionHash),
    index("wallet_funding_agent_idx").on(t.userId, t.agentId, t.createdAt),
    uniqueIndex("wallet_funding_active_agent_idx")
      .on(t.agentId)
      .where(sql`${t.state} NOT IN ('complete', 'abandoned')`),
    check(
      "wallet_funding_state_valid",
      sql`${t.state} IN ('prepared','wallet_pending','deposited','converting','complete','abandoned')`,
    ),
    check(
      "wallet_funding_dates_valid",
      sql`${t.strategyVersion} > 0 AND ${t.createdAt} > 0 AND ${t.expiresAt} > ${t.createdAt} AND ${t.updatedAt} >= ${t.createdAt}`,
    ),
    check(
      "wallet_funding_confirmation_valid",
      sql`(${t.state} IN ('prepared','wallet_pending','abandoned') AND ${t.confirmedAt} IS NULL AND ${t.transactionHash} IS NULL AND ${t.actionId} IS NULL) OR (${t.state} IN ('deposited','converting','complete') AND ${t.confirmedAt} IS NOT NULL AND ${t.transactionHash} IS NOT NULL AND ${t.walletAttemptAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();
