import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { databaseUrl } from "@/server/env";
import * as agentSchema from "./agent-schema";
import * as chatSchema from "./chat-schema";
import * as defiSchema from "./defi-schema";
import * as executionSchema from "./execution-schema";
import * as fundingSchema from "./funding-schema";
import * as manualSchema from "./manual-schema";
import * as nativeFundingSchema from "./native-funding-schema";
import * as nativeSchema from "./native-schema";
import * as portfolioSchema from "./portfolio-schema";
import * as positionSchema from "./position-schema";
import * as previewSchema from "./preview-schema";
import * as riskSchema from "./risk-schema";
import * as baseSchema from "./schema";
import * as subjectSchema from "./subject-schema";
import * as tradingAccountSchema from "./trading-account-schema";
import * as walletSwapSchema from "./wallet-swap-schema";

export const schema = {
  ...baseSchema,
  ...subjectSchema,
  ...manualSchema,
  ...nativeSchema,
  ...nativeFundingSchema,
  ...agentSchema,
  ...chatSchema,
  ...defiSchema,
  ...executionSchema,
  ...positionSchema,
  ...previewSchema,
  ...riskSchema,
  ...tradingAccountSchema,
  ...fundingSchema,
  ...portfolioSchema,
  ...walletSwapSchema,
};
export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

declare global {
  var wrenaiPostgres: { readonly db: AppDatabase; readonly pool: Pool } | undefined;
}

/** A small pool per warm function. Migrations run as an explicit release step, never during requests. */
export function database(): AppDatabase {
  if (globalThis.wrenaiPostgres === undefined) {
    const pool = new Pool({
      connectionString: databaseUrl(),
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
      allowExitOnIdle: true,
    });
    pool.on("error", () => {
      process.emitWarning("An idle Postgres connection was interrupted. The pool will reconnect.", {
        code: "WRENAI_DATABASE_CONNECTION",
      });
    });
    globalThis.wrenaiPostgres = { db: drizzle({ client: pool, schema }), pool };
  }
  return globalThis.wrenaiPostgres.db;
}
