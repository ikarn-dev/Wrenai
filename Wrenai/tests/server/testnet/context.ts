import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { vi } from "vitest";
import { testnetCipher, testnetEnv } from "@/server/testnet/config";
import type { TestnetPlan } from "@/server/testnet/orders";
import type { TestnetOwner } from "@/server/testnet/pool";
import * as schema from "@/server/testnet/schema";
export const USDC = "nep141:usdc.tidepool-sandbox.testnet";
export const USDT = "nep141:usdt.tidepool-sandbox.testnet";
export function configureTestnet(): void {
  const env = {
    APP_URL: "https://testnet.wrenai.example",
    TESTNET_POOL_SEED: Buffer.alloc(32, 1).toString("base64"),
    TESTNET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}
export async function testnetContext() {
  configureTestnet();
  const postgres = new PGlite();
  await postgres.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;",
  );
  await postgres.exec(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id integer, hash text, created_at bigint); INSERT INTO drizzle.__drizzle_migrations VALUES (1, 'mainnet-marker', 9999999999999);",
  );
  const db = drizzle({ client: postgres, schema });
  await migrate(db, { migrationsFolder: "drizzle/testnet", migrationsSchema: "drizzle_testnet" });
  const now = Date.now(),
    owner: TestnetOwner = {
      id: randomUUID(),
      kind: "guest",
      guestIdentity: null,
      accountId: null,
      createdAt: now,
      expiresAt: now + 3600000,
    },
    stranger: TestnetOwner = { ...owner, id: randomUUID() };
  await db.insert(schema.tnOwners).values([owner, stranger]);
  return { db, postgres, owner, stranger };
}
export async function queuedPayment(
  db: Awaited<ReturnType<typeof testnetContext>>["db"],
  owner: TestnetOwner,
  units = "1000000",
) {
  const id = randomUUID();
  const plan: TestnetPlan = {
    intent: { kind: "payment", assetId: USDC, amount: "1", recipient: "recipient.testnet" },
    calls: [
      {
        receiverId: "usdc.tidepool-sandbox.testnet",
        method: "ft_transfer",
        args: { receiver_id: "recipient.testnet", amount: units, memo: "Wrenai testnet" },
        deposit: "1",
        gas: "50000000000000",
      },
    ],
    quote: null,
    signer: testnetEnv().TESTNET_POOL_ACCOUNT_ID,
  };
  const [row] = await db
    .insert(schema.tnOrders)
    .values({
      id,
      ownerId: owner.id,
      requestId: randomUUID(),
      kind: "payment",
      state: "queued",
      assetId: USDC,
      inputUnits: units,
      recipient: "recipient.testnet",
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
      confirmedAt: Date.now(),
      sealedPlan: testnetCipher().seal(owner.id, id, "plan", JSON.stringify(plan)),
    })
    .returning();
  if (!row) {
    throw new Error("Missing fixture order");
  }
  return row;
}
