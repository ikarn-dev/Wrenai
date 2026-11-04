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
import { executionActions } from "./execution-schema";
import { positionLots } from "./position-schema";
import { executionSubjects } from "./subject-schema";

const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
const time = (name: string) => bigint(name, { mode: "number" });
const scopes = ["intents", "confidential", "native_near", "hyperliquid"] as const;
const maximum = sql.raw(MAX_TOKEN_UNITS.toString());

// One receipt namespace and spending source for swaps, native protocols and perps.
export const executionReceipts = pgTable(
  "execution_receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    actionId: text("action_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    kind: text("kind", { enum: ["swap", "defi"] }).notNull(),
    providerEventId: text("provider_event_id").notNull(),
    receiptHash: text("receipt_hash").notNull(),
    receiptJson: text("receipt_json").notNull(),
    riskDebitMicroUsd: units("risk_debit_micro_usd").notNull(),
    borrowedCapitalMicroUsd: units("borrowed_capital_micro_usd").notNull().default(sql`0`),
    recordedAt: time("recorded_at").notNull(),
  },
  (t) => [
    check(
      "execution_receipt_borrowed_valid",
      sql`${t.borrowedCapitalMicroUsd} >= 0 AND ${t.borrowedCapitalMicroUsd} <= ${t.riskDebitMicroUsd} AND (${t.kind} <> 'swap' OR ${t.borrowedCapitalMicroUsd} = 0)`,
    ),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    uniqueIndex("execution_receipt_provider_idx").on(t.userId, t.scope, t.providerEventId),
    uniqueIndex("execution_receipt_owner_id_idx").on(t.userId, t.id),
    index("execution_receipt_action_idx").on(t.actionId),
    check(
      "execution_receipt_shape",
      sql`${t.kind} IN ('swap', 'defi') AND ${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid') AND ${t.riskDebitMicroUsd} > 0 AND ${t.riskDebitMicroUsd} <= ${maximum} AND ${t.receiptHash} ~ '^[a-f0-9]{64}$' AND octet_length(${t.receiptJson}) <= 96000`,
    ),
  ],
).enableRLS();

// Exact first-activation permissions; storing a setup never creates one of these.
export const executionPermissions = pgTable(
  "execution_permissions",
  {
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    permissionHash: text("permission_hash").notNull(),
    permissionJson: text("permission_json").notNull(),
    confirmedAt: time("confirmed_at").notNull(),
    expiresAt: time("expires_at"),
    revokedAt: time("revoked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.permissionHash] }),
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    check(
      "execution_permission_shape",
      sql`${t.permissionHash} ~ '^[a-f0-9]{64}$' AND (${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.confirmedAt}) AND octet_length(${t.permissionJson}) <= 16000`,
    ),
  ],
).enableRLS();

export const defiDisposals = pgTable(
  "defi_disposals",
  {
    userId: text("user_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    lotId: text("lot_id").notNull(),
    quantityUnits: units("quantity_units").notNull(),
    basisMicroUsd: units("basis_micro_usd"),
    principalMicroUsd: units("principal_micro_usd").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.lotId] }),
    foreignKey({
      columns: [t.userId, t.receiptId],
      foreignColumns: [executionReceipts.userId, executionReceipts.id],
    }),
    foreignKey({ columns: [t.userId, t.lotId], foreignColumns: [positionLots.userId, positionLots.id] }),
    check(
      "defi_disposal_values",
      sql`${t.quantityUnits} > 0 AND ${t.quantityUnits} <= ${maximum} AND (${t.basisMicroUsd} IS NULL OR ${t.basisMicroUsd} >= 0) AND ${t.principalMicroUsd} >= 0`,
    ),
  ],
).enableRLS();

export const defiPositions = pgTable(
  "defi_positions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    venueId: text("venue_id").notNull(),
    kind: text("kind", {
      enum: ["lp_share", "collateral", "debt", "staking", "perp_long", "perp_short"],
    }).notNull(),
    instrumentId: text("instrument_id").notNull(),
    version: integer("version").notNull(),
    quantityUnits: units("quantity_units").notNull(),
    principalMicroUsd: units("principal_micro_usd").notNull(),
    receiptId: text("receipt_id").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    foreignKey({
      columns: [t.userId, t.receiptId],
      foreignColumns: [executionReceipts.userId, executionReceipts.id],
    }),
    uniqueIndex("defi_position_market_idx").on(t.userId, t.scope, t.venueId, t.kind, t.instrumentId),
    uniqueIndex("defi_perp_market_idx")
      .on(t.userId, t.scope, t.venueId, t.instrumentId)
      .where(sql`${t.kind} IN ('perp_long', 'perp_short') AND ${t.quantityUnits} > 0`),
    uniqueIndex("defi_position_owner_idx").on(t.userId, t.id),
    check(
      "defi_position_shape",
      sql`${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid') AND ${t.kind} IN ('lp_share', 'collateral', 'debt', 'staking', 'perp_long', 'perp_short') AND ${t.version} > 0 AND ${t.quantityUnits} >= 0 AND ${t.quantityUnits} <= ${maximum} AND ${t.principalMicroUsd} >= 0 AND ${t.principalMicroUsd} <= ${maximum} AND ((${t.kind} NOT IN ('debt', 'perp_long', 'perp_short')) OR ${t.principalMicroUsd} = 0) AND (${t.quantityUnits} > 0 OR ${t.principalMicroUsd} = 0)`,
    ),
  ],
).enableRLS();

export const defiPositionClaims = pgTable(
  "defi_position_claims",
  {
    userId: text("user_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    positionId: text("position_id").notNull(),
    actionId: text("action_id").notNull(),
    venueId: text("venue_id").notNull(),
    kind: text("kind").notNull(),
    instrumentId: text("instrument_id").notNull(),
    releasedAt: time("released_at"),
  },
  (t) => [
    primaryKey({ columns: [t.actionId, t.positionId] }),
    foreignKey({
      columns: [t.userId, t.actionId],
      foreignColumns: [executionActions.userId, executionActions.id],
    }),
    uniqueIndex("defi_position_active_claim_idx")
      .on(t.userId, t.scope, t.venueId, t.kind, t.instrumentId)
      .where(sql`${t.releasedAt} IS NULL`),
    uniqueIndex("defi_perp_active_claim_idx")
      .on(t.userId, t.scope, t.venueId, t.instrumentId)
      .where(sql`${t.kind} IN ('perp_long', 'perp_short') AND ${t.releasedAt} IS NULL`),
  ],
).enableRLS();
