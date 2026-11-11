import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { agentEventView, POLL_FENCE_KINDS } from "@/server/activity/agent-events";
import type { AppDatabase } from "@/server/db/client";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityCursor,
  type ActivityEntry,
  activityEntrySchema,
} from "@/shared/activity";
import { NEAR_TX_HASH } from "@/shared/manual-trading";
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
  // The public NEAR transaction that paid a wallet return out, from 1Click's final accounting.
  payout_tx: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  deleted: z.boolean(),
});
// Titles for the non-agent sources; agent events read through agentEventView.
const titles: Readonly<Record<string, string>> = {
  user_limit: "Account capital limit updated",
  agent_limit: "Agent capital limit updated",
  inventory_assigned: "Assets allocated to agent",
  inventory_released: "Agent allocation released",
  daily_limit: "Daily spending limit updated",
  native_funding: "Native account funding",
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
  let description = row.message.slice(0, 500);
  if (row.category === "agent") {
    const view = agentEventView(row.kind, row.message);
    ({ title, status } = view);
    description = view.detail ?? "";
  } else if (row.category === "trade") {
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
    title =
      row.kind === "wallet_return"
        ? status === "completed"
          ? "Funds returned to wallet"
          : status === "refunded"
            ? "Return refunded"
            : "Returning funds"
        : `${row.kind === "swap" ? "Swap" : "DeFi action"} ${status === "completed" ? "completed" : status === "refunded" ? "refunded" : status === "cancelled" ? "cancelled" : "pending"}`;
    description = `${row.message ? `${row.message} · ` : ""}${venues[row.scope ?? ""] ?? "Trading"}${row.status === "unknown" ? " · Awaiting provider confirmation" : ""}`;
  }
  return activityEntrySchema.parse({
    id: row.id,
    source: "agents",
    category: row.category,
    title,
    status,
    description,
    occurredAt: row.occurred_at,
    // Only a NEAR transaction hash links to NearBlocks; anything else stays out rather than linking wrongly.
    transactionHash: NEAR_TX_HASH.safeParse(row.payout_tx).data ?? null,
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
        AND kind NOT LIKE ${POLL_FENCE_KINDS[0]} AND kind NOT LIKE ${POLL_FENCE_KINDS[1]}
      UNION ALL
      SELECT 'trade:' || x.id, 'trade', CASE WHEN r.wallet_return THEN 'wallet_return' ELSE x.kind END,
        CASE WHEN r.wallet_return THEN (CASE WHEN x.origin='manual' THEN 'Private balance claim' ELSE 'Agent claim' END)
          WHEN x.origin='manual' THEN 'Manual trade' ELSE '' END, x.status, x.scope, x.created_at, NULL::text,
        x.agent_id, x.id
      -- A wallet return is recognized by the event written with its reservation, so plans are never decoded here.
      FROM execution_actions x CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM execution_events e
        WHERE e.user_id = x.user_id AND e.action_id = x.id AND e.kind = 'wallet_return_prepared') AS wallet_return) r
      WHERE x.user_id = ${userId}
        -- A return quote replaced before it was sent moved nothing; only sent returns are activity.
        AND NOT (r.wallet_return AND x.status = 'cancelled')
      UNION ALL
      SELECT 'capital:' || id, 'funding', kind,
        CASE WHEN kind IN ('user_limit', 'agent_limit') THEN 'Capital ceiling changed. No transfer was made.'
          ELSE 'Agent inventory allocation changed.' END,
        'recorded', NULL::text, recorded_at, NULL::text, agent_id, NULL::text
      FROM capital_events WHERE user_id = ${userId}
      UNION ALL
      SELECT 'native-funding:' || id, 'funding', 'native_funding',
        CASE WHEN state='complete' THEN 'Native trading account funded.' WHEN state='cancelled' THEN 'Native funding review cancelled.' ELSE 'Native trading account funding pending.' END,
        'recorded', 'native_near', coalesce(completed_at,created_at), NULL::text, subject_id, NULL::text
      FROM native_deposits WHERE user_id = ${userId}
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
      (SELECT e.detail_json::jsonb -> 'destinationTxHashes' ->> 0 FROM execution_events e
        WHERE e.user_id = ${userId} AND e.action_id = p.action_id AND e.kind = 'wallet_return_terminal'
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS payout_tx,
      a.id AS agent_id, a.name AS agent_name, (a.deleted_at IS NOT NULL) AS deleted
    FROM page p LEFT JOIN agents a ON a.id = p.agent_id AND a.user_id = ${userId}
    ORDER BY p.occurred_at DESC, p.id DESC
  `);
  return z
    .object({ rows: z.array(z.unknown()).max(ACTIVITY_PAGE_SIZE + 1) })
    .parse(result)
    .rows.map(entry);
}
