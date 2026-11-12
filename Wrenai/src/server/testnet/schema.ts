import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

const time = (name: string) => bigint(name, { mode: "number" });
export const tnPool = pgTable("testnet_pool", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  revision: integer("revision").notNull().default(0),
  createdAt: time("created_at").notNull(),
}).enableRLS();
export const tnOwners = pgTable("testnet_owners", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["guest", "wallet"] }).notNull(),
  guestIdentity: text("guest_identity").unique(),
  accountId: text("account_id").unique(),
  createdAt: time("created_at").notNull(),
  expiresAt: time("expires_at").notNull(),
}).enableRLS();
export const tnSessions = pgTable("testnet_sessions", {
  hash: text("hash").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => tnOwners.id),
  expiresAt: time("expires_at").notNull(),
}).enableRLS();
export const tnChallenges = pgTable("testnet_challenges", {
  nonce: text("nonce").primaryKey(),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
}).enableRLS();
export const tnBalances = pgTable(
  "testnet_balances",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => tnOwners.id),
    bucket: text("bucket").notNull(),
    location: text("location", { enum: ["wallet", "intents"] })
      .notNull()
      .default("wallet"),
    assetId: text("asset_id").notNull(),
    units: text("units").notNull(),
    held: text("held").notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.bucket, t.assetId, t.location] }),
    check(
      "tn_balance_location",
      sql`${t.location} IN ('wallet', 'intents') AND (${t.location} = 'wallet' OR ${t.assetId} <> 'native:near')`,
    ),
    check(
      "tn_balance_valid",
      sql`${t.units} ~ '^(0|[1-9][0-9]{0,77})$' AND ${t.held} ~ '^(0|[1-9][0-9]{0,77})$' AND ${t.held}::numeric <= ${t.units}::numeric`,
    ),
  ],
).enableRLS();
export const tnOrders = pgTable(
  "testnet_orders",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => tnOwners.id),
    requestId: text("request_id").notNull(),
    bucket: text("bucket").notNull().default("manual"),
    kind: text("kind", { enum: ["payment", "swap"] }).notNull(),
    state: text("state", {
      enum: ["review", "queued", "prepared", "submitted", "settled", "failed", "needs_review"],
    }).notNull(),
    assetId: text("asset_id").notNull(),
    inputUnits: text("input_units").notNull(),
    location: text("location", { enum: ["wallet", "intents"] })
      .notNull()
      .default("wallet"),
    outputLocation: text("output_location", { enum: ["wallet", "intents"] })
      .notNull()
      .default("wallet"),
    outputAssetId: text("output_asset_id"),
    outputUnits: text("output_units"),
    recipient: text("recipient").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull(),
    confirmedAt: time("confirmed_at"),
    step: integer("step").notNull().default(0),
    sealedPlan: text("sealed_plan").notNull(),
    depositAddress: text("deposit_address").unique(),
    txHash: text("tx_hash"),
    message: text("message"),
  },
  (t) => [
    check(
      "tn_order_locations",
      sql`${t.location} IN ('wallet', 'intents') AND ${t.outputLocation} IN ('wallet', 'intents') AND (${t.location} = 'wallet' OR ${t.assetId} <> 'native:near')`,
    ),
    uniqueIndex("tn_orders_request_idx").on(t.ownerId, t.requestId),
    index("tn_orders_state_idx").on(t.state),
  ],
).enableRLS();
export const tnSubmissions = pgTable(
  "testnet_submissions",
  {
    orderId: text("order_id")
      .notNull()
      .references(() => tnOrders.id),
    step: integer("step").notNull(),
    nonce: text("nonce").notNull(),
    hash: text("hash").notNull().unique(),
    sealedBytes: text("sealed_bytes").notNull(),
    createdAt: time("created_at").notNull(),
    finalizedAt: time("finalized_at"),
    outcome: text("outcome"),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.step] })],
).enableRLS();
export const tnAgents = pgTable(
  "testnet_agents",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => tnOwners.id),
    requestId: text("request_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    // A text column: adding "deleted" needs no migration.
    state: text("state", { enum: ["running", "stopped", "completed", "blocked", "deleted"] }).notNull(),
    sealedRule: text("sealed_rule").notNull(),
    nextAt: time("next_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    slot: integer("slot").notNull().default(0),
    reference: text("reference"),
    reason: text("reason"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [uniqueIndex("tn_agent_request_idx").on(t.ownerId, t.requestId)],
).enableRLS();
export const tnConversations = pgTable("testnet_conversations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => tnOwners.id),
  sealedTitle: text("sealed_title").notNull(),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
  deletedAt: time("deleted_at"),
}).enableRLS();
export const tnMessages = pgTable(
  "testnet_messages",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => tnOwners.id),
    requestId: text("request_id").notNull(),
    conversationId: text("conversation_id"),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    sealedText: text("sealed_text").notNull(),
    sealedEvidence: text("sealed_evidence"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [uniqueIndex("tn_message_request_idx").on(t.ownerId, t.requestId, t.role)],
).enableRLS();

export const tnPayouts = pgTable("testnet_payouts", {
  hash: text("hash").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => tnOrders.id),
  assetId: text("asset_id").notNull(),
  units: text("units").notNull(),
  createdAt: time("created_at").notNull(),
}).enableRLS();
