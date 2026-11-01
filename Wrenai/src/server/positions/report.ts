import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions, executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots, positionRealizations, positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import type { ExecutionScope } from "@/server/execution/contracts";
import { assignedCapitalLimit, attributedPrincipal, committedCapital } from "./capital-records";

interface PositionBalance {
  readonly scope: ExecutionScope;
  readonly assetId: string;
  readonly attributedUnits: bigint;
  readonly reservedUnits: bigint;
  /** Accounting availability only. Quote, fresh wallet inventory and full Guard checks remain mandatory. */
  readonly unreservedUnits: bigint;
  readonly costBasisMicroUsd: bigint | null;
}
export interface AgentPositionReport {
  readonly capitalCeilingMicroUsd: bigint;
  readonly attributedPrincipalMicroUsd: bigint;
  readonly committedCapitalMicroUsd: bigint;
  readonly realizedPnlMicroUsd: bigint | null;
  readonly realizationCount: number;
  readonly unpricedRealizations: number;
  readonly positions: readonly PositionBalance[];
  readonly defiPositions: readonly (typeof defiPositions.$inferSelect)[];
  readonly unpricedDefiReceipts: number;
}

export async function readAgentPositions(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentPositionReport> {
  return userTransaction(db, userId, async (tx) => {
    // Serialize with owner mutations so lots, claims and realized totals describe one accounting state.
    await ownedAgent(tx, userId, agentId);
    const lots = await tx
      .select()
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.agentId, agentId),
          gt(positionLots.remainingUnits, 0n),
        ),
      );
    const holds = await tx
      .select()
      .from(positionReservations)
      .where(
        and(
          eq(positionReservations.userId, userId),
          eq(positionReservations.agentId, agentId),
          gt(positionReservations.heldUnits, 0n),
        ),
      );
    const grouped = new Map<string, PositionBalance>();
    for (const lot of lots) {
      const key = JSON.stringify([lot.scope, lot.assetId]);
      const old = grouped.get(key);
      const held =
        old?.reservedUnits ??
        holds
          .filter((hold) => hold.scope === lot.scope && hold.assetId === lot.assetId)
          .reduce((sum, hold) => sum + hold.heldUnits, 0n);
      const attributed = (old?.attributedUnits ?? 0n) + lot.remainingUnits;
      const basis =
        old === undefined
          ? lot.remainingBasisMicroUsd
          : old.costBasisMicroUsd === null || lot.remainingBasisMicroUsd === null
            ? null
            : old.costBasisMicroUsd + lot.remainingBasisMicroUsd;
      grouped.set(key, {
        scope: lot.scope,
        assetId: lot.assetId,
        attributedUnits: attributed,
        reservedUnits: held,
        unreservedUnits: attributed - held,
        costBasisMicroUsd: basis,
      });
    }
    const [pnl] = await tx
      .select({
        amount: sql<string>`coalesce(sum(${positionRealizations.realizedPnlMicroUsd}), 0)::text`,
        unknown: sql<string>`count(*) filter (where ${positionRealizations.realizedPnlMicroUsd} is null)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(positionRealizations)
      .where(and(eq(positionRealizations.userId, userId), eq(positionRealizations.agentId, agentId)));
    const unknown = Number(pnl?.unknown ?? "0");
    const count = Number(pnl?.count ?? "0");
    const defi = await tx
      .select()
      .from(defiPositions)
      .where(and(eq(defiPositions.userId, userId), eq(defiPositions.agentId, agentId)));
    const [receipts] = await tx
      .select({ count: sql<string>`count(*)::text` })
      .from(executionReceipts)
      .innerJoin(executionActions, eq(executionActions.id, executionReceipts.actionId))
      .where(
        and(
          eq(executionReceipts.userId, userId),
          eq(executionActions.agentId, agentId),
          eq(executionReceipts.kind, "defi"),
        ),
      );
    const unpricedDefiReceipts = Number(receipts?.count ?? "0");
    return {
      capitalCeilingMicroUsd: await assignedCapitalLimit(tx, userId, agentId),
      attributedPrincipalMicroUsd: await attributedPrincipal(tx, userId, agentId),
      committedCapitalMicroUsd: await committedCapital(tx, userId, agentId),
      realizedPnlMicroUsd:
        count === 0 || unknown > 0 || unpricedDefiReceipts > 0 ? null : BigInt(pnl?.amount ?? "0"),
      realizationCount: count,
      unpricedRealizations: unknown,
      positions: [...grouped.values()],
      defiPositions: defi,
      unpricedDefiReceipts,
    };
  });
}
