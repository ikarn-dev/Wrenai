import { bigint, customType, index, pgTable, text } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
const timestamp = (name: string) => bigint(name, { mode: "number" });

// Timestamps are UTC epoch milliseconds.

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  lastSignInAt: timestamp("last_sign_in_at").notNull(),
}).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the session token. The token itself only exists in the user's cookie.
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
).enableRLS();

export const signInChallenges = pgTable(
  "sign_in_challenges",
  {
    // base64url of the 32-byte NEP-413 nonce.
    nonce: text("nonce").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => [index("sign_in_challenges_expires_at_idx").on(table.expiresAt)],
).enableRLS();

// One agent key per user (Spec §3). A revoked key is deleted, secret included.
export const delegatedKeys = pgTable("delegated_keys", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // "ed25519:<base58>", as registered on intents.near.
  publicKey: text("public_key").notNull().unique(),
  // AES-256-GCM under KEY_ENCRYPTION_KEY: 12-byte IV, sealed 32-byte ed25519 seed, 16-byte tag.
  sealedSecret: bytea("sealed_secret").notNull(),
  createdAt: timestamp("created_at").notNull(),
  // Both null until the key is seen on intents.near at final finality; set together.
  activatedAt: timestamp("activated_at"),
  // The final block that first showed the key. Only a later block without it proves a removal.
  activatedAtBlock: timestamp("activated_at_block"),
}).enableRLS();
