import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { MAX_TOKEN_UNITS } from "@/shared/token-units";
import { executionActions, executionFills } from "./execution-schema";
import { users } from "./schema";
import { executionSubjects } from "./subject-schema";

const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
const time = (name: string) => bigint(name, { mode: "number" });
const scopes = ["intents", "confidential", "native_near", "hyperliquid"] as const;
const maximumUnits = sql.raw(MAX_TOKEN_UNITS.toString());

export const capitalAccounts = pgTable(
  "capital_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    limitMicroUsd: units("limit_micro_usd").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [check("capital_account_limit_valid", sql`${t.limitMicroUsd} >= 0`)],
).enableRLS();

export const agentCapital = pgTable(
  "agent_capital",
  {
    userId: text("user_id")
      .notNull()
      .references(() => capitalAccounts.userId),
    agentId: text("agent_id").notNull(),
    limitMicroUsd: units("limit_micro_usd").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.agentId] }),
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    check("agent_capital_limit_valid", sql`${t.limitMicroUsd} >= 0`),
  ],
).enableRLS();

export const positionLots = pgTable(
  "position_lots",
  {
    id: text("id").primaryKey(),
    sequence: bigserial("sequence", { mode: "bigint" }).notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    assetId: text("asset_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceKind: text("source_kind", { enum: ["allocation", "fill", "receipt"] }).notNull(),
    initialUnits: units("initial_units").notNull(),
    remainingUnits: units("remaining_units").notNull(),
    initialBasisMicroUsd: units("initial_basis_micro_usd"),
    remainingBasisMicroUsd: units("remaining_basis_micro_usd"),
    initialPrincipalMicroUsd: units("initial_principal_micro_usd").notNull(),
    remainingPrincipalMicroUsd: units("remaining_principal_micro_usd").notNull(),
    openedAt: time("opened_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [agentCapital.userId, agentCapital.agentId],
    }),
    uniqueIndex("position_lot_source_idx").on(t.userId, t.sourceId, t.assetId),
    uniqueIndex("position_lot_owner_id_idx").on(t.userId, t.id),
    index("position_lot_fifo_idx").on(t.userId, t.agentId, t.scope, t.assetId, t.sequence),
    check(
      "position_lot_scope_valid",
      sql`${t.scope} IN ('intents', 'confidential', 'native_near', 'hyperliquid')`,
    ),
    check("position_lot_source_valid", sql`${t.sourceKind} IN ('allocation', 'fill', 'receipt')`),
    check(
      "position_lot_units_valid",
      sql`${t.initialUnits} > 0 AND ${t.initialUnits} <= ${maximumUnits} AND ${t.remainingUnits} >= 0 AND ${t.remainingUnits} <= ${t.initialUnits}`,
    ),
    check(
      "position_lot_basis_valid",
      sql`(${t.initialBasisMicroUsd} IS NULL AND ${t.remainingBasisMicroUsd} IS NULL) OR (${t.initialBasisMicroUsd} IS NOT NULL AND ${t.remainingBasisMicroUsd} IS NOT NULL AND ${t.initialBasisMicroUsd} >= 0 AND ${t.remainingBasisMicroUsd} >= 0 AND ${t.remainingBasisMicroUsd} <= ${t.initialBasisMicroUsd})`,
    ),
    check(
      "position_lot_principal_valid",
      sql`${t.initialPrincipalMicroUsd} >= 0 AND ${t.remainingPrincipalMicroUsd} >= 0 AND ${t.remainingPrincipalMicroUsd} <= ${t.initialPrincipalMicroUsd}`,
    ),
  ],
).enableRLS();

// Claims reserve aggregate owned units. Actual fills consume FIFO, independent of reservation order.
export const positionReservations = pgTable(
  "position_reservations",
  {
    actionId: text("action_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    scope: text("scope", { enum: scopes }).notNull(),
    assetId: text("asset_id").notNull(),
    initialUnits: units("initial_units").notNull(),
    heldUnits: units("held_units").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.actionId, t.assetId] }),
    foreignKey({
      columns: [t.userId, t.agentId, t.scope, t.actionId],
      foreignColumns: [
        executionActions.userId,
        executionActions.agentId,
        executionActions.scope,
        executionActions.id,
      ],
    }),
    check(
      "position_reservation_units_valid",
      sql`${t.initialUnits} > 0 AND ${t.initialUnits} <= ${maximumUnits} AND ${t.heldUnits} >= 0 AND ${t.heldUnits} <= ${t.initialUnits}`,
    ),
    index("position_reservation_asset_idx").on(t.userId, t.agentId, t.scope, t.assetId),
  ],
).enableRLS();

export const positionRealizations = pgTable(
  "position_realizations",
  {
    fillId: text("fill_id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    basisMicroUsd: units("basis_micro_usd"),
    netProceedsMicroUsd: units("net_proceeds_micro_usd"),
    realizedPnlMicroUsd: units("realized_pnl_micro_usd"),
    principalMicroUsd: units("principal_micro_usd").notNull(),
    recordedAt: time("recorded_at").notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.fillId], foreignColumns: [executionFills.userId, executionFills.id] }),
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    check(
      "position_realization_values_valid",
      sql`(${t.basisMicroUsd} IS NULL OR ${t.basisMicroUsd} >= 0) AND (${t.netProceedsMicroUsd} IS NULL OR ${t.netProceedsMicroUsd} >= 0) AND ${t.principalMicroUsd} >= 0`,
    ),
    check(
      "position_realization_pnl_valid",
      sql`(${t.realizedPnlMicroUsd} IS NULL AND (${t.basisMicroUsd} IS NULL OR ${t.netProceedsMicroUsd} IS NULL)) OR (${t.realizedPnlMicroUsd} IS NOT NULL AND ${t.basisMicroUsd} IS NOT NULL AND ${t.netProceedsMicroUsd} IS NOT NULL AND ${t.realizedPnlMicroUsd} = ${t.netProceedsMicroUsd} - ${t.basisMicroUsd})`,
    ),
  ],
).enableRLS();

export const positionDisposals = pgTable(
  "position_disposals",
  {
    userId: text("user_id").notNull(),
    fillId: text("fill_id").notNull(),
    lotId: text("lot_id").notNull(),
    quantityUnits: units("quantity_units").notNull(),
    basisMicroUsd: units("basis_micro_usd"),
    principalMicroUsd: units("principal_micro_usd").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fillId, t.lotId] }),
    foreignKey({ columns: [t.userId, t.fillId], foreignColumns: [executionFills.userId, executionFills.id] }),
    foreignKey({ columns: [t.userId, t.lotId], foreignColumns: [positionLots.userId, positionLots.id] }),
    check(
      "position_disposal_values_valid",
      sql`${t.quantityUnits} > 0 AND (${t.basisMicroUsd} IS NULL OR ${t.basisMicroUsd} >= 0) AND ${t.principalMicroUsd} >= 0`,
    ),
  ],
).enableRLS();

export const capitalEvents = pgTable(
  "capital_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id"),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    kind: text("kind", {
      enum: ["user_limit", "agent_limit", "inventory_assigned", "inventory_released"],
    }).notNull(),
    resourceId: text("resource_id").notNull(),
    detailJson: text("detail_json").notNull(),
    recordedAt: time("recorded_at").notNull(),
  },
  (t) => [
    uniqueIndex("capital_event_owner_request_idx").on(t.userId, t.requestId),
    foreignKey({
      columns: [t.userId, t.agentId],
      foreignColumns: [executionSubjects.userId, executionSubjects.id],
    }),
    check(
      "capital_event_kind_valid",
      sql`${t.kind} IN ('user_limit', 'agent_limit', 'inventory_assigned', 'inventory_released')`,
    ),
  ],
).enableRLS();
