import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { databaseUrl } from "@/server/env";
import * as schema from "./schema";
export type TestnetDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
let db: TestnetDatabase | undefined;
export function testnetDatabase(): TestnetDatabase {
  if (!db) {
    const pool = new Pool({
      connectionString: databaseUrl(),
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 15000,
      allowExitOnIdle: true,
    });
    pool.on("error", () =>
      process.emitWarning("Testnet database connection interrupted.", { code: "TESTNET_DATABASE" }),
    );
    db = drizzle({ client: pool, schema });
  }
  return db;
}
