import "server-only";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { positionLots } from "@/server/db/position-schema";
import { NATIVE_GAS_ASSET } from "@/server/execution/rhea/contracts";
import { tokenUnitsSchema } from "@/shared/token-units";

const MAX_AGENTS = 50;

export interface AgentFunds {
  readonly id: string;
  readonly name: string;
  readonly status: "paused" | "running" | "stopped" | "error";
  readonly revision: number;
  readonly reason: string;
  /** When the owner's claim started sending its funds to the wallet. */
  readonly claimingSince: number | null;
  /** Deleted by the owner; it stays here until its funds are claimed. */
  readonly deleted: boolean;
  readonly returnAssetId: string | null;
  readonly openPosition: boolean;
  /** Units ever allocated to the agent, per token, and the USD principal they carried when allocated. */
  readonly deposits: readonly { readonly assetId: string; readonly units: bigint }[];
  readonly depositedMicroUsd: bigint;
  /** True when a deposit carried no USD principal (native-account funding), so PnL can't be measured. */
  readonly unvaluedDeposit: boolean;
  /** What the agent holds now, per balance location and token, with the principal still attributed to it. */
  readonly held: readonly { readonly scope: string; readonly assetId: string; readonly units: bigint }[];
  readonly heldPrincipalMicroUsd: bigint;
  /** Deposits paid from the wallet in native NEAR, which the Intents ledger holds as wNEAR. */
  readonly nativeNearDeposit: boolean;
}

const units = (value: unknown): bigint => BigInt(tokenUnitsSchema.parse(String(value)));
const nativeSource = z.object({ walletAssetId: z.string() });

/**
 * The agents that hold funds or are sending them to the wallet, read in five grouped queries (no per-agent round trips).
 * Lots are the authority: deposits are allocation lots, holdings are remaining units, and principal follows the
 * units through every swap, so held value minus held principal is the agent's whole result so far.
 */
export async function readAgentFunds(db: AppDatabase, userId: string): Promise<AgentFunds[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      revision: agents.revision,
      reason: agents.reason,
      claimingSince: agents.claimRequestedAt,
      deleteRequestedAt: agents.deleteRequestedAt,
      returnAssetId: agents.returnAssetId,
    })
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
    .limit(MAX_AGENTS);
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const [held, deposits, positions, fundings] = await Promise.all([
    db
      .select({
        agentId: positionLots.agentId,
        scope: positionLots.scope,
        assetId: positionLots.assetId,
        units: sql<string>`sum(${positionLots.remainingUnits})::text`,
        principal: sql<string>`sum(${positionLots.remainingPrincipalMicroUsd})::text`,
      })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          inArray(positionLots.agentId, ids),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .groupBy(positionLots.agentId, positionLots.scope, positionLots.assetId),
    db
      .select({
        agentId: positionLots.agentId,
        assetId: positionLots.assetId,
        units: sql<string>`sum(${positionLots.initialUnits})::text`,
        principal: sql<string>`sum(${positionLots.initialPrincipalMicroUsd})::text`,
        unvalued: sql<boolean>`bool_or(${positionLots.initialPrincipalMicroUsd} = 0)`,
      })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          inArray(positionLots.agentId, ids),
          eq(positionLots.sourceKind, "allocation"),
        ),
      )
      .groupBy(positionLots.agentId, positionLots.assetId),
    db
      .selectDistinct({ agentId: defiPositions.agentId })
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, userId),
          inArray(defiPositions.agentId, ids),
          gt(defiPositions.quantityUnits, 0n),
        ),
      ),
    db
      .select({ agentId: walletFundings.agentId, snapshotJson: walletFundings.snapshotJson })
      .from(walletFundings)
      .where(and(eq(walletFundings.userId, userId), inArray(walletFundings.agentId, ids)))
      .limit(MAX_AGENTS * 4),
  ]);
  const open = new Set(positions.map((row) => row.agentId));
  const native = new Set(
    fundings.flatMap((row) => {
      const source = nativeSource.safeParse(JSON.parse(row.snapshotJson));
      return source.success && source.data.walletAssetId === NATIVE_GAS_ASSET ? [row.agentId] : [];
    }),
  );
  return rows.flatMap((row) => {
    const own = held.filter((lot) => lot.agentId === row.id);
    const given = deposits.filter((lot) => lot.agentId === row.id);
    if (own.length === 0 && row.claimingSince === null) {
      return [];
    }
    const { deleteRequestedAt, ...agent } = row;
    return [
      {
        ...agent,
        deleted: deleteRequestedAt !== null,
        openPosition: open.has(row.id),
        deposits: given.map((lot) => ({ assetId: lot.assetId, units: units(lot.units) })),
        depositedMicroUsd: given.reduce((sum, lot) => sum + units(lot.principal), 0n),
        unvaluedDeposit: given.some((lot) => lot.unvalued),
        held: own.map((lot) => ({ scope: lot.scope, assetId: lot.assetId, units: units(lot.units) })),
        heldPrincipalMicroUsd: own.reduce((sum, lot) => sum + units(lot.principal), 0n),
        nativeNearDeposit: native.has(row.id),
      },
    ];
  });
}

/**
 * Free private balance per token: the observed balance minus every agent's attribution, the owner's own manual
 * holds and legacy unreleased orders. The same subtraction as `manualAvailableUnits`, for every token at once.
 */
export async function readFreePrivateBalances(
  db: AppDatabase,
  userId: string,
): Promise<{ readonly assetId: string; readonly units: bigint; readonly observedAt: number | null }[]> {
  const result = await db.execute(sql`
    WITH manual AS (
      SELECT id FROM execution_subjects WHERE user_id = ${userId} AND kind = 'manual' LIMIT 1
    )
    SELECT i.asset_id, i.observed_at,
      (i.balance_units
        - (SELECT coalesce(sum(l.remaining_units), 0) FROM position_lots l
            WHERE l.user_id = i.user_id AND l.scope = 'confidential' AND l.asset_id = i.asset_id
              AND l.agent_id NOT IN (SELECT id FROM manual))
        - (SELECT coalesce(sum(r.held_units), 0) FROM position_reservations r
            WHERE r.user_id = i.user_id AND r.scope = 'confidential' AND r.asset_id = i.asset_id
              AND r.agent_id IN (SELECT id FROM manual))
        - (SELECT coalesce(sum(a.input_units), 0) FROM execution_actions a
            LEFT JOIN position_reservations r2 ON r2.action_id = a.id
            WHERE a.user_id = i.user_id AND a.scope = 'confidential' AND a.input_asset_id = i.asset_id
              AND a.reservation_released_at IS NULL AND r2.action_id IS NULL)
      )::text AS free_units
    FROM execution_inventory i
    WHERE i.user_id = ${userId} AND i.scope = 'confidential'
    LIMIT 200
  `);
  const rows = z
    .object({
      rows: z
        .array(
          z.object({
            asset_id: z.string(),
            observed_at: z.coerce.number().int().nullable(),
            free_units: z.string().regex(/^-?\d+$/),
          }),
        )
        .max(200),
    })
    .parse(result).rows;
  return rows.flatMap((row) => {
    const free = BigInt(row.free_units);
    return free > 0n ? [{ assetId: row.asset_id, units: free, observedAt: row.observed_at }] : [];
  });
}
