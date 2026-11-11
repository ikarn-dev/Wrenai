import { defineConfig } from "drizzle-kit";
import { parseDatabaseUrl } from "./src/server/db/connection-url";

const { DATABASE_URL } = process.env;

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/server/db/schema.ts",
    "./src/server/db/subject-schema.ts",
    "./src/server/db/manual-schema.ts",
    "./src/server/db/native-schema.ts",
    "./src/server/db/native-funding-schema.ts",
    "./src/server/db/agent-schema.ts",
    "./src/server/db/chat-schema.ts",
    "./src/server/db/defi-schema.ts",
    "./src/server/db/execution-schema.ts",
    "./src/server/db/position-schema.ts",
    "./src/server/db/preview-schema.ts",
    "./src/server/db/risk-schema.ts",
    "./src/server/db/trading-account-schema.ts",
    "./src/server/db/funding-schema.ts",
    "./src/server/db/portfolio-schema.ts",
    "./src/server/db/wallet-swap-schema.ts",
  ],
  out: "./drizzle/postgres",
  ...(DATABASE_URL === undefined || DATABASE_URL === ""
    ? {}
    : { dbCredentials: { url: parseDatabaseUrl(DATABASE_URL) } }),
});
