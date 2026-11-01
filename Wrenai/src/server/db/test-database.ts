import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as agentSchema from "./agent-schema";
import * as chatSchema from "./chat-schema";
import * as defiSchema from "./defi-schema";
import * as executionSchema from "./execution-schema";
import * as positionSchema from "./position-schema";
import * as previewSchema from "./preview-schema";
import * as riskSchema from "./risk-schema";
import * as baseSchema from "./schema";
import * as telegramSchema from "./telegram-schema";
import * as tradingAccountSchema from "./trading-account-schema";

const schema = {
  ...baseSchema,
  ...agentSchema,
  ...chatSchema,
  ...defiSchema,
  ...executionSchema,
  ...positionSchema,
  ...previewSchema,
  ...riskSchema,
  ...telegramSchema,
  ...tradingAccountSchema,
};

/** In-process PostgreSQL for unit tests. No sockets, local server or cloud credentials. */
export async function testDatabase(): Promise<{ db: PgliteDatabase<typeof schema>; postgres: PGlite }> {
  const postgres = new PGlite();
  const db = drizzle({ client: postgres, schema });
  await migrate(db, { migrationsFolder: "drizzle/postgres" });
  await db.insert(baseSchema.users).values(
    ["owner", "stranger"].map((id) => ({
      id,
      accountId: `${id}.near`,
      createdAt: 1,
      lastSignInAt: 1,
    })),
  );
  return { db, postgres };
}
