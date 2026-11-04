import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { MAX_TOKEN_UNITS } from "@/shared/token-units";
import { users } from "./schema";
import { executionSubjects } from "./subject-schema";

const time = (name: string) => bigint(name, { mode: "number" });
// 78 digits covers 256-bit token amounts. Drizzle maps these directly to bigint.
const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
const scopes = ["intents", "confidential", "native_near", "hyperliquid"] as const;
// CHECK DDL cannot use bind parameters. This literal is computed solely from a fixed numeric constant.
const maximumUnits = sql.raw(MAX_TOKEN_UNITS.toString());

export const executionWallets = pgTable(
  "execution_wallets",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope", { enum: scopes }).notNull(),
    revision: integer("revision").notNull().default(0),
    synchronizedAt: time("synchronized_at"),
    syncToken: text("sync_token"),
    syncExpiresAt: time("sync_expires_at"),
    syncRevision: integer("sync_revision"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scope] }),
    check(
      "execution_wallet_scope_valid",
      sql`${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid')`,
    ),
    check("execution_wallet_revision_valid", sql`${t.revision} >= 0`),
  ],
).enableRLS();

export const executionInventory = pgTable(
  "execution_inventory",
  {
    userId: text("user_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    assetId: text("asset_id").notNull(),
    balanceUnits: units("balance_units").notNull(),
    observedAt: time("observed_at"),
    syncToken: text("sync_token"),
    syncExpiresAt: time("sync_expires_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scope, t.assetId] }),
    foreignKey({
      columns: [t.userId, t.scope],
      foreignColumns: [executionWallets.userId, executionWallets.scope],
    }),
    check(
      "execution_inventory_nonnegative",
      sql`${t.balanceUnits} >= 0 AND ${t.balanceUnits} <= ${maximumUnits}`,
    ),
    check(
      "execution_inventory_scope_valid",
      sql`${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid')`,
    ),
  ],
).enableRLS();

export const executionActions = pgTable(
  "execution_actions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    origin: text("origin", { enum: ["agent", "manual"] })
      .notNull()
      .default("agent"),
    requestId: text("request_id").notNull(),
    planHash: text("plan_hash").notNull(),
    planJson: text("plan_json").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    kind: text("kind", { enum: ["swap", "defi"] })
      .notNull()
      .default("swap"),
    inputAssetId: text("input_asset_id"),
    outputAssetId: text("output_asset_id"),
    inputUnits: units("input_units"),
    minOutputUnits: units("min_output_units"),
    notionalMicroUsd: units("notional_micro_usd").notNull(),
    capitalReservationMicroUsd: units("capital_reservation_micro_usd").notNull().default(sql`0`),
    expiresAt: time("expires_at").notNull(),
    status: text("status", {
      enum: ["reserved", "submitting", "submitted", "unknown", "settled", "cancelled"],
    }).notNull(),
    approvedAt: time("approved_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: time("lease_expires_at"),
    payloadHash: text("payload_hash"),
    providerRequestId: text("provider_request_id"),
    signingPublicKey: text("signing_public_key").notNull(),
    reservationReleasedAt: time("reservation_released_at"),
    settledAt: time("settled_at"),
    startedAt: time("started_at"),
    settlementHash: text("settlement_hash"),
    settlementReceiptId: text("settlement_receipt_id"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    check("execution_action_origin_valid", sql`${t.origin} IN ('agent', 'manual')`),
    uniqueIndex("execution_action_owner_request_idx").on(t.userId, t.requestId),
    uniqueIndex("execution_action_owner_id_idx").on(t.userId, t.id),
    uniqueIndex("execution_provider_request_idx").on(t.scope, t.providerRequestId),
    uniqueIndex("execution_terminal_receipt_idx").on(t.userId, t.scope, t.settlementReceiptId),
    index("execution_action_agent_time_idx").on(t.agentId, t.createdAt),
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    foreignKey({
      columns: [t.userId, t.scope],
      foreignColumns: [executionWallets.userId, executionWallets.scope],
    }),
    check(
      "execution_action_amounts_positive",
      sql`${t.notionalMicroUsd} > 0 AND ${t.notionalMicroUsd} <= ${maximumUnits} AND (
        (${t.kind} = 'swap' AND ${t.inputAssetId} IS NOT NULL AND ${t.outputAssetId} IS NOT NULL AND ${t.inputAssetId} <> ${t.outputAssetId} AND ${t.inputUnits} IS NOT NULL AND ${t.minOutputUnits} IS NOT NULL AND ${t.inputUnits} > 0 AND ${t.minOutputUnits} > 0)
        OR (${t.kind} = 'defi' AND ${t.inputAssetId} IS NULL AND ${t.outputAssetId} IS NULL AND ${t.inputUnits} IS NULL AND ${t.minOutputUnits} IS NULL))`,
    ),
    check(
      "execution_action_state_valid",
      sql`${t.status} IN ('reserved', 'submitting', 'submitted', 'unknown', 'settled', 'cancelled')`,
    ),
    check(
      "execution_capital_reservation_valid",
      sql`${t.capitalReservationMicroUsd} >= 0 AND ${t.capitalReservationMicroUsd} <= ${t.notionalMicroUsd} AND (${t.kind} <> 'swap' OR ${t.capitalReservationMicroUsd} = 0)`,
    ),
    check(
      "execution_action_scope_valid",
      sql`${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid')`,
    ),
    check(
      "execution_action_units_bound",
      sql`${t.inputUnits} <= ${maximumUnits} AND ${t.minOutputUnits} <= ${maximumUnits}`,
    ),
    uniqueIndex("execution_action_position_owner_idx").on(t.userId, t.agentId, t.scope, t.id),
  ],
).enableRLS();

// Receipt IDs are scoped to the provider account, not to an action: replay cannot credit another action.
export const executionFills = pgTable(
  "execution_fills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    actionId: text("action_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    providerEventId: text("provider_event_id").notNull(),
    receiptHash: text("receipt_hash").notNull(),
    inputUnits: units("input_units").notNull(),
    outputUnits: units("output_units").notNull(),
    inputValueMicroUsd: units("input_value_micro_usd").notNull(),
    outputValueMicroUsd: units("output_value_micro_usd"),
    feeMicroUsd: units("fee_micro_usd"),
    occurredAt: time("occurred_at").notNull(),
    recordedAt: time("recorded_at").notNull(),
  },
  (t) => [
    uniqueIndex("execution_fill_receipt_idx").on(t.userId, t.scope, t.providerEventId),
    uniqueIndex("execution_fill_owner_id_idx").on(t.userId, t.id),
    index("execution_fill_action_idx").on(t.actionId),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    check(
      "execution_fill_amounts_valid",
      sql`${t.inputUnits} > 0 AND ${t.outputUnits} > 0 AND ${t.inputValueMicroUsd} > 0 AND (${t.feeMicroUsd} IS NULL OR ${t.feeMicroUsd} >= 0)`,
    ),
    check("execution_fill_scope_valid", sql`${t.scope} IN ('intents', 'confidential', 'native_near')`),
    check(
      "execution_fill_units_bound",
      sql`${t.inputUnits} <= ${maximumUnits} AND ${t.outputUnits} <= ${maximumUnits}`,
    ),
    check(
      "execution_fill_output_value_valid",
      sql`${t.outputValueMicroUsd} IS NULL OR ${t.outputValueMicroUsd} >= 0`,
    ),
  ],
).enableRLS();

export const executionEvents = pgTable(
  "execution_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    actionId: text("action_id").notNull(),
    kind: text("kind").notNull(),
    detailJson: text("detail_json").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    index("execution_event_action_time_idx").on(t.actionId, t.createdAt),
  ],
).enableRLS();
