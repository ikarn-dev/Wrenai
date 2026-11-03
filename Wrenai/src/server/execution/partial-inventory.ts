import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionInventory, executionWallets } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError, type ExecutionScope, inventoryObservationSchema } from "./contracts";
import { releaseFreshInventoryHolds } from "./inventory-release";
import { quarantinedAssets } from "./inventory-state";
import { databaseTime } from "./records";

const deadlineMs = 10_000;
function coverage(raw: readonly string[]): readonly string[] {
  const ids = z.array(z.string().min(1).max(256)).min(1).max(12).parse(raw);
  if (new Set(ids).size !== ids.length) {
    throw new ExecutionError("conflict", "An inventory refresh cannot repeat account locations.");
  }
  return ids;
}
/** Separate derived addresses refresh concurrently. Token leases still fence all observations under the owner lock. */
export async function beginPartialInventorySync(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
  raw: readonly string[],
): Promise<string> {
  const ids = coverage(raw);
  return userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx),
      token = randomUUID();
    await tx.insert(executionWallets).values({ userId, scope }).onConflictDoNothing();
    const [wallet] = await tx
      .select()
      .from(executionWallets)
      .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, scope)))
      .limit(1);
    if (wallet?.syncExpiresAt !== null && wallet?.syncExpiresAt !== undefined && wallet.syncExpiresAt > now) {
      throw new ExecutionError("conflict", "A complete account observation is already in progress.");
    }
    for (const assetId of ids) {
      await tx
        .insert(executionInventory)
        .values({ userId, scope, assetId, balanceUnits: 0n, observedAt: null })
        .onConflictDoNothing();
      const [row] = await tx
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
      if (row?.syncExpiresAt !== null && row?.syncExpiresAt !== undefined && row.syncExpiresAt > now) {
        throw new ExecutionError("conflict", "This trading address is already being refreshed.");
      }
    }
    await tx
      .update(executionInventory)
      .set({ syncToken: token, syncExpiresAt: now + deadlineMs })
      .where(
        and(
          eq(executionInventory.userId, userId),
          eq(executionInventory.scope, scope),
          inArray(executionInventory.assetId, [...ids]),
        ),
      );
    return token;
  });
}
export async function finishPartialInventorySync(
  db: AppDatabase,
  userId: string,
  raw: unknown,
  rawIds: readonly string[],
): Promise<void> {
  const observation = inventoryObservationSchema.parse(raw),
    ids = coverage(rawIds);
  if (observation.balances.some((balance) => !ids.includes(balance.assetId))) {
    throw new ExecutionError("conflict", "The observation includes an undeclared trading address.");
  }
  await userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx),
      rows = await tx
        .select()
        .from(executionInventory)
        .where(
          and(
            eq(executionInventory.userId, userId),
            eq(executionInventory.scope, observation.scope),
            inArray(executionInventory.assetId, [...ids]),
          ),
        );
    if (
      rows.length !== ids.length ||
      rows.some(
        (row) =>
          row.syncToken !== observation.syncToken || row.syncExpiresAt === null || row.syncExpiresAt <= now,
      )
    ) {
      throw new ExecutionError("conflict", "This address observation expired or raced a financial action.");
    }
    const frozen = await quarantinedAssets(tx, userId, observation.scope);
    for (const row of rows) {
      if (row.syncExpiresAt === null) {
        throw new ExecutionError("conflict", "The inventory observation lease is missing.");
      }
      const balance = observation.balances.find((item) => item.assetId === row.assetId);
      await tx
        .update(executionInventory)
        .set({
          ...(frozen.has(row.assetId)
            ? {}
            : {
                balanceUnits: BigInt(balance?.amountUnits ?? "0"),
                observedAt: row.syncExpiresAt - deadlineMs,
              }),
          syncToken: null,
          syncExpiresAt: null,
        })
        .where(
          and(
            eq(executionInventory.userId, userId),
            eq(executionInventory.scope, observation.scope),
            eq(executionInventory.assetId, row.assetId),
          ),
        );
    }
    await releaseFreshInventoryHolds(tx, userId, now);
  });
}
export async function assertNoPartialInventorySync(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
  now: number,
): Promise<void> {
  const [row] = await db
    .select({ assetId: executionInventory.assetId })
    .from(executionInventory)
    .where(
      and(
        eq(executionInventory.userId, userId),
        eq(executionInventory.scope, scope),
        gt(executionInventory.syncExpiresAt, now),
      ),
    )
    .limit(1);
  if (row) {
    throw new ExecutionError("conflict", "A trading-address observation is already in progress.");
  }
}
