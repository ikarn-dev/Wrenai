import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityCursor,
  type ActivityEntry,
  activityEntrySchema,
} from "@/shared/activity";
import { tokenUnitsSchema } from "@/shared/token-units";

const rowSchema = z.object({
  id: z.string(),
  category: z.enum(["agent", "trade", "funding", "settings", "security"]),
  kind: z.string(),
  message: z.string(),
  status: z.string(),
  scope: z.string().nullable(),
  occurred_at: z.coerce.number().int(),
  amount: tokenUnitsSchema.nullable(),
  terminal: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  deleted: z.boolean(),
});
const titles: Readonly<Record<string, string>> = {
  whale_alert: "Watched wallet movement",
  strategy_saved: "Strategy saved",
  cloned: "Agent cloned",
  pause: "Agent paused",
  stop: "Agent stopped",
  delete: "Agent deleted",
  global_stop: "All agents stopped",
  global_stop_cleared: "Global stop cleared",
  runtime_requested: "Agent starting",
  strategy_check_failed: "Strategy check failed",
  runtime_failed: "Agent blocked",
  user_limit: "Account capital limit updated",
  agent_limit: "Agent capital limit updated",
  inventory_assigned: "Assets allocated to agent",
  inventory_released: "Agent allocation released",
  daily_limit: "Daily spending limit updated",
  recovery_created: "Trading account created",
  backup_confirmed: "Recovery backup confirmed",
  access_revoked: "Trading account access revoked",
};
const venues: Readonly<Record<string, string>> = {
  intents: "NEAR Intents",
  confidential: "Confidential Intents",
  native_near: "NEAR",
  hyperliquid: "Hyperliquid",
};

function entry(raw: unknown): ActivityEntry {
  const row = rowSchema.parse(raw);
  let status: ActivityEntry["status"] = "recorded";
  let title = titles[row.kind] ?? "Agent updated";
  if (row.category === "trade") {
    let refunded = false;
    if (row.terminal !== null) {
      try {
        const terminal: unknown = JSON.parse(row.terminal);
        refunded = z.object({ status: z.literal("REFUNDED") }).safeParse(terminal).success;
      } catch {
        // A damaged optional provider detail must not hide the authoritative action state.
        refunded = false;
      }
    }
    status = refunded
      ? "refunded"
      : row.status === "settled"
        ? "completed"
        : row.status === "cancelled"
          ? "cancelled"
          : "pending";
    title = `${row.kind === "swap" ? "Swap" : "DeFi action"} ${status === "completed" ? "completed" : status === "refunded" ? "refunded" : status === "cancelled" ? "cancelled" : "pending"}`;
  } else if (row.kind === "runtime_failed" || row.kind === "strategy_check_failed") {
    status = "failed";
  }
  return activityEntrySchema.parse({
    id: row.id,
    source: "agents",
    category: row.category,
    title,
    status,
    description:
      row.category === "trade"
        ? `${venues[row.scope ?? ""] ?? "Trading"}${row.status === "unknown" ? " · Awaiting provider confirmation" : ""}`
        : row.message.slice(0, 500),
    occurredAt: row.occurred_at,
    transactionHash: null,
    agent:
      row.agent_id && row.agent_name !== null
        ? { id: row.agent_id, name: row.agent_name, deleted: row.deleted }
        : null,
    amount:
      row.amount === null || status === "refunded"
        ? null
        : { kind: "usd", microUsd: row.amount, estimated: row.category === "trade" },
  });
}

/** A bounded owner-scoped read model. Never loads policies, prompts, plans or encrypted trading keys. */
export async function appActivityPage(
  db: AppDatabase,
  userId: string,
  cursor: ActivityCursor,
): Promise<readonly ActivityEntry[]> {
  const before = cursor.app.before;
  const boundary = before === null ? sql`true` : sql`(h.occurred_at, h.id) < (${before.at}, ${before.id})`;
  const result = await db.execute(sql`
    WITH history AS (
      SELECT 'agent:' || id AS id, 'agent' AS category, kind, message, 'recorded' AS status,
        NULL::text AS scope, created_at AS occurred_at, NULL::text AS amount, agent_id, NULL::text AS action_id
      FROM agent_events WHERE user_id = ${userId}
      UNION ALL
      SELECT 'trade:' || id, 'trade', kind, '', status, scope, created_at, NULL::text, agent_id, id
      FROM execution_actions WHERE user_id = ${userId}
      UNION ALL
      SELECT 'capital:' || id, 'funding', kind,
        CASE WHEN kind IN ('user_limit', 'agent_limit') THEN 'Capital ceiling changed. No transfer was made.'
          ELSE 'Agent inventory allocation changed.' END,
        'recorded', NULL::text, recorded_at, NULL::text, agent_id, NULL::text
      FROM capital_events WHERE user_id = ${userId}
      UNION ALL
      SELECT 'risk:' || revision::text, 'settings', 'daily_limit', 'Account-wide daily spending limit.',
        'recorded', NULL::text, created_at, daily_cap_micro_usd::text, NULL::text, NULL::text
      FROM user_risk_policies WHERE user_id = ${userId}
      UNION ALL
      SELECT 'security:' || t.id || ':' || v.kind, 'security', v.kind, '', 'recorded', NULL::text,
        v.at, NULL::text, NULL::text, NULL::text
      FROM trading_accounts t CROSS JOIN LATERAL (VALUES
        ('recovery_created', t.created_at), ('backup_confirmed', t.backup_confirmed_at), ('access_revoked', t.revoked_at)
      ) v(kind, at) WHERE t.user_id = ${userId} AND v.at IS NOT NULL
    ), page AS (
      SELECT * FROM history h WHERE h.occurred_at <= ${cursor.snapshotAt} AND ${boundary}
      ORDER BY h.occurred_at DESC, h.id DESC LIMIT ${ACTIVITY_PAGE_SIZE + 1}
    )
    SELECT p.id, p.category, p.kind, p.message, p.status, p.scope, p.occurred_at,
      CASE WHEN p.action_id IS NULL THEN p.amount ELSE
        (SELECT sum(f.input_value_micro_usd)::text FROM execution_fills f WHERE f.user_id = ${userId} AND f.action_id = p.action_id)
      END AS amount,
      (SELECT e.detail_json FROM execution_events e WHERE e.user_id = ${userId} AND e.action_id = p.action_id
        AND e.kind = 'intents_terminal' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS terminal,
      a.id AS agent_id, a.name AS agent_name, (a.deleted_at IS NOT NULL) AS deleted
    FROM page p LEFT JOIN agents a ON a.id = p.agent_id AND a.user_id = ${userId}
    ORDER BY p.occurred_at DESC, p.id DESC
  `);
  return z
    .object({ rows: z.array(z.unknown()).max(ACTIVITY_PAGE_SIZE + 1) })
    .parse(result)
    .rows.map(entry);
}
