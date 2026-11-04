import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as agentSchema from "@/server/db/agent-schema";
import * as chatSchema from "@/server/db/chat-schema";
import * as defiSchema from "@/server/db/defi-schema";
import * as executionSchema from "@/server/db/execution-schema";
import * as fundingSchema from "@/server/db/funding-schema";
import * as manualSchema from "@/server/db/manual-schema";
import * as nativeFundingSchema from "@/server/db/native-funding-schema";
import * as nativeSchema from "@/server/db/native-schema";
import * as portfolioSchema from "@/server/db/portfolio-schema";
import * as positionSchema from "@/server/db/position-schema";
import * as previewSchema from "@/server/db/preview-schema";
import * as riskSchema from "@/server/db/risk-schema";
import * as baseSchema from "@/server/db/schema";
import * as subjectSchema from "@/server/db/subject-schema";
import * as telegramSchema from "@/server/db/telegram-schema";
import * as tradingAccountSchema from "@/server/db/trading-account-schema";
import * as walletSwapSchema from "@/server/db/wallet-swap-schema";

const schema = {
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
  ...telegramSchema,
  ...tradingAccountSchema,
  ...fundingSchema,
  ...portfolioSchema,
  ...walletSwapSchema,
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
