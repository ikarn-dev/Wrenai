import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { z } from "zod";
import { parseDatabaseUrl } from "../src/server/db/connection-url.ts";
import { LEGACY_DELEGATED_KEY_IMPORT, serializeLegacyRows } from "../src/server/db/legacy-data.ts";

// Fixed identifiers only. json_populate_recordset uses Postgres types and constraints; values stay parameterized.
const tables = [
  {
    name: "users",
    read: "SELECT id, account_id, created_at, last_sign_in_at FROM users",
    write: "INSERT INTO users SELECT * FROM json_populate_recordset(NULL::users, $1::json)",
  },
  {
    name: "sign_in_challenges",
    read: "SELECT * FROM sign_in_challenges",
    write:
      "INSERT INTO sign_in_challenges SELECT * FROM json_populate_recordset(NULL::sign_in_challenges, $1::json)",
  },
  {
    name: "sessions",
    read: "SELECT * FROM sessions",
    write: "INSERT INTO sessions SELECT * FROM json_populate_recordset(NULL::sessions, $1::json)",
  },
  {
    name: "delegated_keys",
    read: "SELECT * FROM delegated_keys",
    write: LEGACY_DELEGATED_KEY_IMPORT,
  },
  {
    name: "agents",
    read: "SELECT * FROM agents",
    write: "INSERT INTO agents SELECT * FROM json_populate_recordset(NULL::agents, $1::json)",
  },
  {
    name: "strategy_versions",
    read: "SELECT * FROM strategy_versions",
    write:
      "INSERT INTO strategy_versions SELECT * FROM json_populate_recordset(NULL::strategy_versions, $1::json)",
  },
  {
    name: "strategy_drafts",
    read: "SELECT * FROM strategy_drafts",
    write:
      "INSERT INTO strategy_drafts SELECT * FROM json_populate_recordset(NULL::strategy_drafts, $1::json)",
  },
  {
    name: "agent_requests",
    read: "SELECT * FROM agent_requests",
    write: "INSERT INTO agent_requests SELECT * FROM json_populate_recordset(NULL::agent_requests, $1::json)",
  },
  {
    name: "agent_events",
    read: "SELECT * FROM agent_events",
    write: "INSERT INTO agent_events SELECT * FROM json_populate_recordset(NULL::agent_events, $1::json)",
  },
  {
    name: "trading_controls",
    read: "SELECT * FROM trading_controls",
    write:
      "INSERT INTO trading_controls SELECT * FROM json_populate_recordset(NULL::trading_controls, $1::json)",
  },
] as const;

const { DATABASE_URL } = process.env;
const connectionString = parseDatabaseUrl(DATABASE_URL);
if (process.argv[2] !== "--confirm-empty-target") {
  throw new Error(
    "Import requires --confirm-empty-target. Stop old app writes, back up SQLite and migrate an empty target first.",
  );
}
const source = new DatabaseSync(resolve(process.argv[3] ?? "data/wrenai.db"), { readOnly: true });
const pool = new Pool({ connectionString, max: 1 });
try {
  source.exec("BEGIN");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "LOCK TABLE users, sign_in_challenges, sessions, delegated_keys, agents, strategy_versions, strategy_drafts, agent_requests, agent_events, trading_controls, strategy_parse_jobs IN ACCESS EXCLUSIVE MODE",
    );
    const result = await client.query(
      "SELECT EXISTS (SELECT 1 FROM users UNION ALL SELECT 1 FROM sign_in_challenges) AS occupied",
    );
    const occupied = z.object({ occupied: z.boolean() }).parse(result.rows[0]);
    if (occupied.occupied) {
      throw new Error("The target is not empty.");
    }
    const counts: string[] = [];
    for (const table of tables) {
      const query = source.prepare(table.read);
      query.setReadBigInts(true);
      const rows = query.all();
      if (rows.length > 0) {
        const inserted = await client.query(table.write, [serializeLegacyRows(rows)]);
        if (inserted.rowCount !== rows.length) {
          throw new Error("The import count did not match its source.");
        }
      }
      counts.push(`${table.name}: ${rows.length}`);
    }
    await client.query("COMMIT");
    process.stdout.write(`Import committed. Source was read-only.\n${counts.join("\n")}\n`);
  } catch {
    await client.query("ROLLBACK");
    throw new Error(
      "Import failed and was rolled back. Verify the target is empty, schema is migrated and source schema is current. SQLite was not modified.",
    );
  } finally {
    client.release();
  }
} finally {
  source.close();
  await pool.end();
}
