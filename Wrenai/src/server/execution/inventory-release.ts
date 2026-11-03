import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims } from "@/server/db/defi-schema";
import { executionActions, executionInventory, executionWallets } from "@/server/db/execution-schema";
import { positionLots } from "@/server/db/position-schema";
import { releaseOwnedInput } from "@/server/positions/execution";
import { defiPlanSchema } from "./defi-contracts";
import { actionCashLocations, quarantinedAssets } from "./inventory-state";
import type { LedgerAction } from "./records";

/** Every location must be read after settlement; refreshing only a bridge's source cannot release its hold. */
export async function releasableInventoryActions(
  db: AppDatabase,
  userId: string,
): Promise<readonly LedgerAction[]> {
  const terminal = await db
    .select()
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.status, "settled"),
        isNull(executionActions.reservationReleasedAt),
      ),
    );
  const released: LedgerAction[] = [];
  for (const action of terminal) {
    let fresh = action.settledAt !== null;
    const funding =
      action.kind === "defi" && defiPlanSchema.parse(JSON.parse(action.planJson)).funding === true;
    for (const location of actionCashLocations(action)) {
      if ((await quarantinedAssets(db, userId, location.scope)).has(location.assetId)) {
        fresh = false;
        break;
      }
      const [balance] = await db
        .select()
        .from(executionInventory)
        .where(
          and(
            eq(executionInventory.userId, userId),
            eq(executionInventory.scope, location.scope),
            eq(executionInventory.assetId, location.assetId),
          ),
        )
        .limit(1);
      const [wallet] = await db
        .select()
        .from(executionWallets)
        .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, location.scope)))
        .limit(1);
      const observedAt = balance ? balance.observedAt : wallet?.synchronizedAt;
      if (
        observedAt === null ||
        observedAt === undefined ||
        action.settledAt === null ||
        observedAt < action.settledAt
      ) {
        fresh = false;
        break;
      }
      // The bridge's foreign credit must actually arrive. Ordinary settled receipts retain their
      // original release semantics; unrelated balance shortfalls still block new spending below.
      if (!funding || location.scope === action.scope) {
        continue;
      }
      const [owned] = await db
        .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
        .from(positionLots)
        .where(
          and(
            eq(positionLots.userId, userId),
            eq(positionLots.scope, location.scope),
            eq(positionLots.assetId, location.assetId),
          ),
        );
      if ((balance?.balanceUnits ?? 0n) < BigInt(owned?.units ?? "0")) {
        fresh = false;
        break;
      }
    }
    if (fresh) {
      released.push(action);
    }
  }
  return released;
}
export async function releaseFreshInventoryHolds(
  db: AppDatabase,
  userId: string,
  now: number,
): Promise<void> {
  const released = await releasableInventoryActions(db, userId),
    ids = released.map((action) => action.id);
  if (ids.length === 0) {
    return;
  }
  await db
    .update(executionActions)
    .set({ reservationReleasedAt: now })
    .where(inArray(executionActions.id, ids));
  await db
    .update(defiPositionClaims)
    .set({ releasedAt: now })
    .where(and(eq(defiPositionClaims.userId, userId), inArray(defiPositionClaims.actionId, ids)));
  await releaseOwnedInput(db, userId, ids);
}
