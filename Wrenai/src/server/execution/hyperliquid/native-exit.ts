import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims, defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "../records";
import type { HlAccountState } from "./account-state";
import type { PerpsCheckpoint } from "./checkpoint";
import { type HlOrder, perpsCashAssetId, perpsInstrumentId } from "./contracts";
import type { PerpsFillAccounting } from "./fill-accounting";
import type { HlFunding } from "./funding-observation";
import type { HlFill } from "./observations";
import type { HlOrderRecord } from "./order-record";
import { settlePerpsFills } from "./settlement";

function observationRequest(
  entryId: string,
  fills: readonly HlFill[],
  funding: readonly HlFunding[],
): string {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "hl-native-exit:v1",
        entryId,
        fills.map((fill) => [fill.time, fill.coin, fill.tid, fill.oid]),
        funding.map((row) => [row.time, row.hash, row.delta.coin, row.delta.usdc]),
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Owned native exits and corroborated liquidations can settle after pause/revocation. This never signs or submits. */
export async function settleNativePerpsExit(
  db: AppDatabase,
  entry: LedgerAction,
  saved: HlOrderRecord,
  checkpoint: PerpsCheckpoint,
  result: PerpsFillAccounting,
  state: HlAccountState,
  fills: readonly HlFill[],
  openIds: ReadonlySet<number>,
  known: ReadonlyMap<number, HlOrder>,
  funding: readonly HlFunding[] = [],
): Promise<void> {
  const fundingOnly = fills.length === 0 && funding.length > 0;
  if (
    (fills.length === 0 && !fundingOnly) ||
    (fundingOnly
      ? result.quantity !== BigInt(checkpoint.quantity)
      : result.quantity >= BigInt(checkpoint.quantity)) ||
    result.risk <= 0n ||
    fills.some((fill) => !known.get(fill.oid)?.r)
  ) {
    throw new ExecutionError("conflict", "A native receipt must prove a strictly reducing owned order.");
  }
  const requestId = observationRequest(entry.id, fills, funding),
    source = defiPlanSchema.parse(JSON.parse(entry.planJson));
  await userTransaction(db, entry.userId, async (tx) => {
    const [previous] = await tx
      .select()
      .from(executionActions)
      .where(and(eq(executionActions.userId, entry.userId), eq(executionActions.requestId, requestId)))
      .limit(1);
    if (previous?.status === "settled") {
      return;
    }
    if (previous) {
      throw new ExecutionError(
        "conflict",
        "The observed native receipt already has an unresolved accounting claim.",
      );
    }
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, entry.userId),
          eq(executionActions.agentId, entry.agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (pending) {
      throw new ExecutionError("not_ready", "Reconcile the in-flight action before recording a native exit.");
    }
    const instrumentId = perpsInstrumentId(saved.address, saved.market.name),
      rows = await tx
        .select()
        .from(defiPositions)
        .where(
          and(
            eq(defiPositions.userId, entry.userId),
            eq(defiPositions.agentId, entry.agentId),
            eq(defiPositions.instrumentId, instrumentId),
          ),
        );
    const exposure = rows.find((position) => position.kind === "perp_long" || position.kind === "perp_short"),
      collateral = rows.find((position) => position.kind === "collateral");
    if (
      !exposure ||
      !collateral ||
      exposure.quantityUnits.toString() !== checkpoint.quantity ||
      collateral.quantityUnits.toString() !== checkpoint.collateral ||
      collateral.principalMicroUsd.toString() !== checkpoint.collateralPrincipal
    ) {
      throw new ExecutionError(
        "conflict",
        "The native exit no longer matches its owned position checkpoint.",
      );
    }
    const cashAsset = perpsCashAssetId(saved.address);
    if (
      result.debit > (await unreservedOwnedUnits(tx, entry.userId, entry.agentId, "hyperliquid", cashAsset))
    ) {
      throw new ExecutionError("not_ready", "The native exit cash debit has no remaining owned cash lot.");
    }
    const now = await databaseTime(tx),
      token = randomUUID();
    const plan = defiPlanSchema.parse({
      ...source,
      requestId,
      operation: "perp_reduce",
      reduceOnly: true,
      cash: [{ assetId: cashAsset, maxDebitUnits: result.debit.toString(), minCreditUnits: "0" }],
      positions: [
        {
          positionId: exposure.id,
          kind: exposure.kind,
          instrumentId,
          expectedVersion: exposure.version,
          beforeUnits: exposure.quantityUnits.toString(),
          minAfterUnits: "0",
          maxAfterUnits: (fundingOnly ? exposure.quantityUnits : exposure.quantityUnits - 1n).toString(),
        },
        {
          positionId: collateral.id,
          kind: "collateral",
          instrumentId,
          expectedVersion: collateral.version,
          beforeUnits: collateral.quantityUnits.toString(),
          minAfterUnits: "0",
          maxAfterUnits: (fundingOnly ? result.collateral : collateral.quantityUnits).toString(),
        },
      ],
      notionalMicroUsd: result.risk.toString(),
      quoteId: `hl-native:${requestId}`,
      quoteHash: executionHash({ state, fills, funding }),
      payloadHash: executionHash({ fills, funding }),
      expiresAt: now + 30_000,
    });
    const [action] = await tx
      .insert(executionActions)
      .values({
        id: randomUUID(),
        userId: entry.userId,
        agentId: entry.agentId,
        origin: entry.origin,
        requestId,
        planHash: executionHash(plan),
        planJson: JSON.stringify(plan),
        agentRevision: entry.agentRevision,
        strategyVersion: entry.strategyVersion,
        policyHash: entry.policyHash,
        scope: "hyperliquid",
        kind: "defi",
        notionalMicroUsd: result.risk,
        capitalReservationMicroUsd: 0n,
        expiresAt: plan.expiresAt,
        status: "submitting",
        approvedAt: entry.approvedAt,
        signingPublicKey: entry.signingPublicKey,
        leaseToken: token,
        leaseExpiresAt: now + 30_000,
        startedAt: fills[0]?.time ?? state.time,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!action) {
      throw new ExecutionError("not_ready", "The observed native exit could not be recorded.");
    }
    if (result.debit > 0n) {
      await tx.insert(positionReservations).values({
        userId: entry.userId,
        agentId: entry.agentId,
        scope: "hyperliquid",
        actionId: action.id,
        assetId: cashAsset,
        initialUnits: result.debit,
        heldUnits: result.debit,
      });
    }
    await tx.insert(defiPositionClaims).values(
      plan.positions.map((position) => ({
        userId: entry.userId,
        scope: "hyperliquid" as const,
        actionId: action.id,
        positionId: position.positionId,
        venueId: "hyperliquid",
        kind: position.kind,
        instrumentId,
      })),
    );
    await executionEvent(tx, action, "hl_native_observation", now, {
      entryActionId: entry.id,
      fills: fills.map((fill) => fill.tid),
      funding: funding.map((row) => ({ hash: row.hash, time: row.time })),
      checkpointTime: checkpoint.time,
    });
    await settlePerpsFills(
      tx,
      action,
      token,
      saved,
      result,
      state,
      fills,
      openIds,
      known,
      checkpoint,
      funding,
    );
  });
}
