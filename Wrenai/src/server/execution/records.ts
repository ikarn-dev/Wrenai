import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents, executionWallets } from "@/server/db/execution-schema";
import { ExecutionError, type ExecutionScope } from "./contracts";

export type LedgerAction = typeof executionActions.$inferSelect;
export type ExecutionAction = LedgerAction & {
  readonly kind: "swap";
  readonly inputAssetId: string;
  readonly outputAssetId: string;
  readonly inputUnits: bigint;
  readonly minOutputUnits: bigint;
};
export function swapAction(action: LedgerAction): ExecutionAction {
  if (
    action.kind !== "swap" ||
    action.inputAssetId === null ||
    action.outputAssetId === null ||
    action.inputUnits === null ||
    action.minOutputUnits === null
  ) {
    throw new ExecutionError("conflict", "A non-swap action cannot use swap accounting.");
  }
  return {
    ...action,
    kind: "swap",
    inputAssetId: action.inputAssetId,
    outputAssetId: action.outputAssetId,
    inputUnits: action.inputUnits,
    minOutputUnits: action.minOutputUnits,
  };
}
export const IN_FLIGHT = ["submitting", "submitted", "unknown"] as const;
export const SNAPSHOT_MAX_AGE_MS = 15_000;

/** Normalized schema objects have stable field order and string financial quantities. */
export function executionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function databaseTime(db: AppDatabase): Promise<number> {
  const result = await db.execute(
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000)::float8 AS now`,
  );
  return z.object({ rows: z.tuple([z.object({ now: z.number().int().nonnegative() })]) }).parse(result)
    .rows[0].now;
}

export async function ownedExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
): Promise<ExecutionAction> {
  return swapAction(await ownedLedgerAction(db, userId, actionId));
}

export async function ownedLedgerAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
): Promise<LedgerAction> {
  const [action] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.id, actionId)))
    .limit(1);
  if (action === undefined) {
    throw new ExecutionError("not_found", "Execution action not found.");
  }
  return action;
}

export async function executionEvent(
  db: AppDatabase,
  action: LedgerAction,
  kind: string,
  now: number,
  detail: unknown = {},
): Promise<void> {
  await db.insert(executionEvents).values({
    id: randomUUID(),
    userId: action.userId,
    actionId: action.id,
    kind,
    detailJson: JSON.stringify(detail),
    createdAt: now,
  });
}

export async function invalidateInventory(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
): Promise<void> {
  await db
    .update(executionWallets)
    .set({
      revision: sql`${executionWallets.revision} + 1`,
      syncToken: null,
      syncExpiresAt: null,
      syncRevision: null,
    })
    .where(and(eq(executionWallets.userId, userId), eq(executionWallets.scope, scope)));
}

export function requireLease(action: LedgerAction, token: string, now: number): void {
  if (action.leaseToken !== token || action.leaseExpiresAt === null || action.leaseExpiresAt <= now) {
    throw new ExecutionError(
      "lease_lost",
      "Execution ownership expired or was replaced. Reconcile before continuing.",
    );
  }
}
