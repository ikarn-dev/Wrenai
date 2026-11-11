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
import { AGENT_PACK_NAMES } from "@/shared/agents";
import { users } from "./schema";

const timestamp = (name: string) => bigint(name, { mode: "number" });

// Financial quantities are canonical decimal strings of smallest units, never floating point.
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pack: text("pack", { enum: AGENT_PACK_NAMES }).notNull(),
    status: text("status", { enum: ["paused", "running", "stopped", "error"] }).notNull(),
    reason: text("reason").notNull(),
    revision: integer("revision").notNull().default(1),
    version: integer("version").notNull().default(1),
    policyJson: text("policy_json").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    // Set when the owner deletes an agent. It leaves the Agents list at once and is deleted once it holds nothing;
    // funds it still holds wait in Claims. Deleting never sends funds anywhere (user decision, Nov 5 2026).
    deleteRequestedAt: timestamp("delete_requested_at"),
    // Set while the owner's claim sends the agent's funds to their wallet; the only authority for a wallet return.
    claimRequestedAt: timestamp("claim_requested_at"),
    // The NEAR token the owner chose to receive claimed funds in; null returns every token as held.
    returnAssetId: text("return_asset_id"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    uniqueIndex("agents_owner_name_idx").on(table.userId, table.name),
    uniqueIndex("agents_owner_id_idx").on(table.userId, table.id),
    index("agents_user_idx").on(table.userId),
  ],
).enableRLS();

export const strategyVersions = pgTable(
  "strategy_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    strategyText: text("strategy_text").notNull(),
    configJson: text("config_json").notNull(),
    resolvedAssetsJson: text("resolved_assets_json"),
    attestationJson: text("attestation_json").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [uniqueIndex("strategy_agent_version_idx").on(table.agentId, table.version)],
).enableRLS();

export const strategyDrafts = pgTable(
  "strategy_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    pack: text("pack", { enum: AGENT_PACK_NAMES }).notNull(),
    strategyText: text("strategy_text").notNull(),
    configJson: text("config_json").notNull(),
    attestationJson: text("attestation_json").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => [uniqueIndex("draft_owner_request_idx").on(table.userId, table.requestId)],
).enableRLS();

export const agentEvents = pgTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    detailJson: text("detail_json").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("agent_events_owner_time_idx").on(table.userId, table.createdAt)],
).enableRLS();

export const agentRequests = pgTable(
  "agent_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    agentId: text("agent_id").notNull(),
  },
  (table) => [uniqueIndex("agent_request_owner_idx").on(table.userId, table.requestId)],
).enableRLS();

export const tradingControls = pgTable("trading_controls", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull(),
}).enableRLS();

export const agentRuntimes = pgTable(
  "agent_runtimes",
  {
    agentId: text("agent_id").primaryKey(),
    userId: text("user_id").notNull(),
    activationId: text("activation_id").notNull().unique(),
    inputHash: text("input_hash").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    strategyVersion: integer("strategy_version").notNull(),
    workflowRunId: text("workflow_run_id"),
    segment: integer("segment").notNull().default(0),
    nextCheckAt: timestamp("next_check_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    failures: integer("failures").notNull().default(0),
    strategyStateJson: text("strategy_state_json"),
    state: text("state", { enum: ["starting", "active", "stopped", "blocked"] }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.userId, t.agentId], foreignColumns: [agents.userId, agents.id] }),
    check(
      "agent_runtime_state_valid",
      sql`${t.state} IN ('starting', 'active', 'stopped', 'blocked') AND ${t.agentRevision} > 0 AND ${t.strategyVersion} > 0 AND ${t.segment} >= 0 AND ${t.failures} >= 0 AND ${t.inputHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("agent_runtime_lease_valid", sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
  ],
).enableRLS();

// A database lease prevents duplicate inference across independently scaled functions.
export const strategyParseJobs = pgTable(
  "strategy_parse_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    leaseToken: text("lease_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at").notNull(),
  },
  (table) => [uniqueIndex("parse_job_owner_request_idx").on(table.userId, table.requestId)],
).enableRLS();
