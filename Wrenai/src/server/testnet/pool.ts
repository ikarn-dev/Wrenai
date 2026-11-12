import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { balanceKey, type TestnetLocation, testnetAsset } from "@/shared/testnet";
import { minimumUnits } from "@/shared/token-units";
import { TestnetError, testnetEnv } from "./config";
import type { TestnetDatabase } from "./database";
import { publicIntentsBalances } from "./intents";
import { testnetBalance, testnetChain } from "./rpc";
import { tnBalances, tnOrders, tnOwners, tnPool } from "./schema";
export const GAS_CAP = 5n * 10n ** 22n;
export type TestnetOwner = typeof tnOwners.$inferSelect;
export async function poolTransaction<T>(
  db: TestnetDatabase,
  run: (tx: TestnetDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx
      .insert(tnPool)
      .values({ id: "pool", accountId: testnetEnv().TESTNET_POOL_ACCOUNT_ID, createdAt: Date.now() })
      .onConflictDoNothing();
    const [pool] = await tx.select().from(tnPool).where(eq(tnPool.id, "pool")).for("update");
    if (pool?.accountId !== testnetEnv().TESTNET_POOL_ACCOUNT_ID) {
      throw new TestnetError("conflict", "The configured testnet pool identity changed.");
    }
    const result = await run(tx);
    await tx
      .update(tnPool)
      .set({ revision: sql`${tnPool.revision}+1` })
      .where(eq(tnPool.id, "pool"));
    return result;
  });
}
export async function ownedBalance(
  db: TestnetDatabase,
  owner: string,
  asset: string,
  bucket = "manual",
  location: TestnetLocation = "wallet",
): Promise<typeof tnBalances.$inferSelect> {
  const [b] = await db
    .select()
    .from(tnBalances)
    .where(
      and(
        eq(tnBalances.ownerId, owner),
        eq(tnBalances.assetId, asset),
        eq(tnBalances.bucket, bucket),
        eq(tnBalances.location, location),
      ),
    );
  return b ?? { ownerId: owner, bucket, location, assetId: asset, units: "0", held: "0" };
}
export async function changeBalance(
  db: TestnetDatabase,
  owner: string,
  asset: string,
  units: bigint,
  held: bigint,
  bucket = "manual",
  location: TestnetLocation = "wallet",
): Promise<void> {
  const b = await ownedBalance(db, owner, asset, bucket, location),
    next = BigInt(b.units) + units,
    reserved = BigInt(b.held) + held;
  if (next < 0n || reserved < 0n || reserved > next) {
    throw new TestnetError("limit", "This action exceeds your available testnet allocation.");
  }
  await db
    .insert(tnBalances)
    .values({
      ownerId: owner,
      bucket,
      location,
      assetId: asset,
      units: next.toString(),
      held: reserved.toString(),
    })
    .onConflictDoUpdate({
      target: [tnBalances.ownerId, tnBalances.bucket, tnBalances.assetId, tnBalances.location],
      set: { units: next.toString(), held: reserved.toString() },
    });
}
export async function grantGuest(
  db: TestnetDatabase,
  owner: TestnetOwner,
  actual: ReadonlyMap<string, bigint>,
  expectedRevision: number,
): Promise<void> {
  const env = testnetEnv();
  const [pool] = await db.select().from(tnPool).where(eq(tnPool.id, "pool"));
  if (pool?.revision !== expectedRevision) {
    throw new TestnetError("conflict", "The pool changed during the balance check. Try again.");
  }
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tnOwners)
    .where(and(eq(tnOwners.kind, "guest"), gte(tnOwners.createdAt, Date.now() - 86400000)));
  if (count > env.TESTNET_MAX_GUESTS_PER_DAY) {
    throw new TestnetError("limit", "Today's guest capacity is full. Try later.");
  }
  const [pending] = await db
    .select({ id: tnOrders.id })
    .from(tnOrders)
    .innerJoin(tnOwners, eq(tnOrders.ownerId, tnOwners.id))
    .where(
      and(
        eq(tnOwners.kind, "guest"),
        inArray(tnOrders.state, ["queued", "prepared", "submitted", "needs_review"]),
      ),
    )
    .limit(1);
  if (pending) {
    throw new TestnetError("conflict", "The guest pool is reconciling a transaction. Try again shortly.");
  }
  if ((actual.get("native:near") ?? 0n) < env.reserve + GAS_CAP) {
    throw new TestnetError(
      "funding_required",
      "The guest pool needs native NEAR on testnet before accepting guests.",
    );
  }
  // A returning guest keeps what it holds, including tokens it swapped into; its starter tokens are topped back up
  // to the grant, counting what its agents hold too, so cycling sessions never stacks allowances.
  const owned = await db.select().from(tnBalances).where(eq(tnBalances.ownerId, owner.id));
  for (const a of env.allowances) {
    const held = owned.filter((b) => b.assetId === a.assetId).reduce((n, b) => n + BigInt(b.units), 0n);
    let remaining = a.units > held ? a.units - held : 0n;
    const locations: readonly TestnetLocation[] =
      a.assetId === "native:near" ? ["wallet"] : ["intents", "wallet"];
    for (const location of locations) {
      const [{ total } = { total: "0" }] = await db
        .select({ total: sql<string>`coalesce(sum(${tnBalances.units}::numeric),0)::text` })
        .from(tnBalances)
        .where(and(eq(tnBalances.assetId, a.assetId), eq(tnBalances.location, location)));
      const floor = a.assetId === "native:near" ? env.reserve : 0n;
      const free = (actual.get(balanceKey(a.assetId, location)) ?? 0n) - BigInt(total) - floor;
      if (free < 0n) {
        throw new TestnetError(
          "funding_required",
          "Existing guest allocations are not fully backed. New guests are paused.",
        );
      }
      const grant = minimumUnits(remaining, free);
      if (grant > 0n) {
        await changeBalance(db, owner.id, a.assetId, grant, 0n, "manual", location);
      }
      remaining -= grant;
    }
    if (remaining > 0n) {
      throw new TestnetError(
        "funding_required",
        `The guest pool needs more test ${testnetAsset(a.assetId).symbol}. Existing allocations are protected.`,
      );
    }
  }
}
export async function poolObservations(
  db: TestnetDatabase,
): Promise<{ revision: number; balances: ReadonlyMap<string, bigint> }> {
  const [pool] = await db.select().from(tnPool).where(eq(tnPool.id, "pool"));
  await testnetChain();
  const env = testnetEnv();
  const assets = new Set(["native:near", ...env.allowances.map((a) => a.assetId)]);
  const native = await testnetBalance(env.TESTNET_POOL_ACCOUNT_ID, "native:near");
  if (native < env.reserve + GAS_CAP) {
    throw new TestnetError(
      "funding_required",
      "The guest pool needs native NEAR on testnet before accepting guests.",
    );
  }
  const intents = await publicIntentsBalances(env.TESTNET_POOL_ACCOUNT_ID);
  return {
    revision: pool?.revision ?? 0,
    balances: new Map(
      [...intents]
        .map(([asset, units]) => [balanceKey(asset, "intents"), units] as const)
        .concat(
          await Promise.all(
            [...assets].map(
              async (a) =>
                [
                  a,
                  a === "native:near" ? native : await testnetBalance(env.TESTNET_POOL_ACCOUNT_ID, a),
                ] as const,
            ),
          ),
        ),
    ),
  };
}
export async function actionCapacity(
  db: TestnetDatabase,
  owner: TestnetOwner,
  assetId: string,
  units: bigint,
): Promise<void> {
  const env = testnetEnv();
  if (owner.expiresAt <= Date.now()) {
    throw new TestnetError("unauthorized", "This guest session expired.");
  }
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tnOrders)
    // Per allowance: a renewed guest's earlier orders don't count against its new allowance.
    .where(and(eq(tnOrders.ownerId, owner.id), gte(tnOrders.confirmedAt, owner.createdAt)));
  const [{ daily } = { daily: 0 }] = await db
    .select({ daily: sql<number>`count(*)::int` })
    .from(tnOrders)
    .where(gte(tnOrders.confirmedAt, Date.now() - 86400000));
  if (count >= env.TESTNET_MAX_ACTIONS_PER_GUEST || daily >= env.TESTNET_MAX_ACTIONS_PER_DAY) {
    throw new TestnetError("limit", "The testnet action limit has been reached.");
  }
  const cap = env.allowances.find((a) => a.assetId === assetId)?.cap;
  if (cap === undefined || units > cap) {
    throw new TestnetError("limit", "This amount exceeds the testnet per-action cap.");
  }
}
