import { defineConfig } from "drizzle-kit";
import { parseDatabaseUrl } from "./src/server/db/connection-url";

const configured = process.env["DATABASE_URL"];
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/testnet/schema.ts",
  out: "./drizzle/testnet",
  migrations: { schema: "drizzle_testnet", table: "__drizzle_migrations" },
  ...(configured ? { dbCredentials: { url: parseDatabaseUrl(configured) } } : {}),
});
