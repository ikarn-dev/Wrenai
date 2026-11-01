import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims } from "@/server/db/defi-schema";
import { executionActions, executionInventory, executionWallets } from "@/server/db/execution-schema";
import { positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { releaseOwnedInput } from "@/server/positions/execution";
import { ExecutionError, type ExecutionScope, inventoryObservationSchema, scopeSchema } from "./contracts";
import { actionCashAssets, quarantinedAssets } from "./inventory-state";
import { databaseTime, SNAPSHOT_MAX_AGE_MS } from "./records";

const SYNC_DEADLINE_MS = 10_000;

/** Internal adapter protocol: acquire before reading a complete, finalized provider inventory outside the transaction. */
export async function beginInventorySync(
  db: AppDatabase,
  userId: string,
  rawScope: unknown,
): Promise<string> {
  const scope = scopeSchema.parse(rawScope);
  return userTransaction(db, userId, async (tx) => {
    await tx.insert(executionWallets).values({ userId, scope }).onConflictDoNothing();
    const now = await databaseTime(tx);
    const [wallet] = await tx
      .select()
      .from(executionWallets)
      .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, scope)));
    if (wallet === undefined) {
      throw new ExecutionError("not_ready", "Inventory account is unavailable.");
    }
    if (wallet.syncExpiresAt !== null && wallet.syncExpiresAt > now) {
      throw new ExecutionError("conflict", "Inventory is already being refreshed.");
    }
    const token = randomUUID();
    await tx
      .update(executionWallets)
      .set({ syncToken: token, syncExpiresAt: now + SYNC_DEADLINE_MS, syncRevision: wallet.revision })
      .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, scope)));
    return token;
  });
}

/** Accept only adapter-verified observations; this is not a client balance-credit endpoint. */
export async function finishInventorySync(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const observation = inventoryObservationSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx);
    const where = and(eq(executionWallets.userId, userId), eq(executionWallets.scope, observation.scope));
    const [wallet] = await tx.select().from(executionWallets).where(where);
    if (
      wallet === undefined ||
      wallet.syncToken !== observation.syncToken ||
      wallet.syncExpiresAt === null ||
      wallet.syncExpiresAt <= now ||
      wallet.syncRevision !== wallet.revision
    ) {
      throw new ExecutionError(
        "conflict",
        "Inventory observation expired or raced an execution. Read it again.",
      );
    }
    const frozen = [...(await quarantinedAssets(tx, userId, observation.scope))];
    const observedAt = wallet.syncExpiresAt - SYNC_DEADLINE_MS;
    await tx
      .delete(executionInventory)
      .where(
        and(
          eq(executionInventory.userId, userId),
          eq(executionInventory.scope, observation.scope),
          frozen.length === 0 ? undefined : notInArray(executionInventory.assetId, frozen),
        ),
      );
    const fresh = observation.balances.filter((balance) => !frozen.includes(balance.assetId));
    if (fresh.length > 0) {
      await tx.insert(executionInventory).values(
        fresh.map((balance) => ({
          userId,
          scope: observation.scope,
          assetId: balance.assetId,
          balanceUnits: BigInt(balance.amountUnits),
          observedAt,
        })),
      );
    }
    // A terminal receipt alone does not make its funds reusable. Refresh actual inventory first.
    const terminal = await tx
      .select()
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.scope, observation.scope),
          eq(executionActions.status, "settled"),
          isNull(executionActions.reservationReleasedAt),
        ),
      );
    const released = terminal.filter((action) =>
      actionCashAssets(action).every((asset) => !frozen.includes(asset)),
    );
    if (released.length > 0) {
      const ids = released.map((a) => a.id);
      await tx
        .update(executionActions)
        .set({ reservationReleasedAt: now })
        .where(inArray(executionActions.id, ids));
      await tx
        .update(defiPositionClaims)
        .set({ releasedAt: now })
        .where(and(eq(defiPositionClaims.userId, userId), inArray(defiPositionClaims.actionId, ids)));
    }
    await releaseOwnedInput(
      tx,
      userId,
      released.map((action) => action.id),
    );
    await tx
      .update(executionWallets)
      .set({
        synchronizedAt: observedAt,
        revision: wallet.revision + 1,
        syncToken: null,
        syncExpiresAt: null,
        syncRevision: null,
      })
      .where(where);
  });
}

export async function availableInventory(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
  assetId: string,
  now: number,
): Promise<bigint> {
  const balance = await observedInventoryBalance(db, userId, scope, assetId, now);
  const [held] = await db
    .select({ units: sql<string>`coalesce(sum(${executionActions.inputUnits}), 0)::text` })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.scope, scope),
        eq(executionActions.kind, "swap"),
        eq(executionActions.inputAssetId, assetId),
        isNull(executionActions.reservationReleasedAt),
      ),
    );
  const [defiHeld] = await db
    .select({ units: sql<string>`coalesce(sum(${positionReservations.initialUnits}), 0)::text` })
    .from(positionReservations)
    .innerJoin(executionActions, eq(positionReservations.actionId, executionActions.id))
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.scope, scope),
        eq(executionActions.kind, "defi"),
        eq(positionReservations.assetId, assetId),
        isNull(executionActions.reservationReleasedAt),
      ),
    );
  return balance - BigInt(held?.units ?? "0") - BigInt(defiHeld?.units ?? "0");
}

/** Raw confirmed inventory, before local reservation/position attribution deductions. */
export async function observedInventoryBalance(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
  assetId: string,
  now: number,
): Promise<bigint> {
  if ((await quarantinedAssets(db, userId, scope)).has(assetId)) {
    throw new ExecutionError(
      "not_ready",
      "This asset is quarantined until its unresolved submissions are reconciled.",
    );
  }
  const [wallet] = await db
    .select()
    .from(executionWallets)
    .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, scope)))
    .limit(1);
  const [inventory] = await db
    .select()
    .from(executionInventory)
    .where(
      and(
        eq(executionInventory.userId, userId),
        eq(executionInventory.scope, scope),
        eq(executionInventory.assetId, assetId),
      ),
    )
    .limit(1);
  const observedAt = inventory === undefined ? wallet?.synchronizedAt : inventory.observedAt;
  if (
    observedAt === undefined ||
    observedAt === null ||
    observedAt > now ||
    now - observedAt >= SNAPSHOT_MAX_AGE_MS
  ) {
    throw new ExecutionError(
      "not_ready",
      "A fresh verified inventory observation is required for this asset.",
    );
  }
  return inventory?.balanceUnits ?? 0n;
}
