import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { TestnetDatabase } from "./database";
import { advanceTestnetOrder, rejectUnsignedOrder } from "./execution";
import { changeBalance } from "./pool";
import { tnAgents, tnBalances, tnOrders, tnOwners } from "./schema";

/**
 * How long a guest's holdings outlive its session: the guest identity cookie's lifetime (session.ts →
 * prepareGuestIdentity), after which that browser can never return to them.
 */
export const GUEST_RETENTION_MS = 30 * 86_400_000;
// Balance rows per grant; older abandoned rows are reached by later grants.
const RECLAIM_BATCH = 100;

/**
 * Ends a guest session: its agents stop and unsigned orders are rejected, so nothing new is spent. Its holdings,
 * including tokens it swapped into, stay with the guest for its next session. Returns whether submitted orders still
 * need settling.
 */
export async function expireTestnetGuest(db: TestnetDatabase, ownerId: string): Promise<boolean> {
  const [owner] = await db.select().from(tnOwners).where(eq(tnOwners.id, ownerId));
  if (owner?.kind !== "guest" || owner.expiresAt > Date.now()) {
    return false;
  }
  await db
    .update(tnAgents)
    .set({ state: "stopped", reason: "Your guest session ended. Its funds wait in Claims." })
    .where(and(eq(tnAgents.ownerId, ownerId), inArray(tnAgents.state, ["running", "blocked"])));
  const pending = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.ownerId, ownerId), inArray(tnOrders.state, ["queued", "prepared", "submitted"])));
  for (const order of pending) {
    if (order.state === "queued" && !order.txHash) {
      await rejectUnsignedOrder(db, order.id, "Session expired before submission.");
    } else {
      await advanceTestnetOrder(db, order.id);
    }
  }
  return pending.length > 0;
}

/**
 * Returns to the pool the free units of guests whose identity has expired too, so abandoned allocations don't keep
 * pool funds from new guests. Runs inside the pool transaction before a grant. Held units (unsettled orders) stay.
 */
export async function reclaimAbandonedGuests(tx: TestnetDatabase, now: number): Promise<void> {
  const rows = await tx
    .select({ balance: tnBalances })
    .from(tnBalances)
    .innerJoin(tnOwners, eq(tnBalances.ownerId, tnOwners.id))
    .where(
      and(
        eq(tnOwners.kind, "guest"),
        lt(tnOwners.expiresAt, now - GUEST_RETENTION_MS),
        sql`${tnBalances.units}::numeric > ${tnBalances.held}::numeric`,
      ),
    )
    .limit(RECLAIM_BATCH);
  for (const { balance } of rows) {
    await changeBalance(
      tx,
      balance.ownerId,
      balance.assetId,
      BigInt(balance.held) - BigInt(balance.units),
      0n,
      balance.bucket,
      balance.location,
    );
  }
}
