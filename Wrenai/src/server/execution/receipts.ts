import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { ExecutionError } from "./contracts";
import { executionHash, type LedgerAction } from "./records";

/** Called under the owner lock, before applying either swap or multi-asset accounting. */
export async function existingReceipt(
  db: AppDatabase,
  action: LedgerAction,
  providerEventId: string,
  receiptHash: string,
): Promise<boolean> {
  const [receipt] = await db
    .select()
    .from(executionReceipts)
    .where(
      and(
        eq(executionReceipts.userId, action.userId),
        eq(executionReceipts.scope, action.scope),
        eq(executionReceipts.providerEventId, providerEventId),
      ),
    )
    .limit(1);
  if (receipt === undefined) {
    return false;
  }
  if (receipt.actionId !== action.id || receipt.receiptHash !== receiptHash || receipt.kind !== action.kind) {
    throw new ExecutionError("conflict", "This provider receipt already belongs to different action data.");
  }
  return true;
}

export async function insertReceipt(
  db: AppDatabase,
  action: LedgerAction,
  providerEventId: string,
  receipt: unknown,
  riskDebitMicroUsd: bigint,
  recordedAt: number,
  borrowedCapitalMicroUsd = 0n,
  id = randomUUID(),
): Promise<string> {
  await db.insert(executionReceipts).values({
    id,
    userId: action.userId,
    actionId: action.id,
    scope: action.scope,
    kind: action.kind,
    providerEventId,
    receiptHash: executionHash(receipt),
    receiptJson: JSON.stringify(receipt),
    riskDebitMicroUsd,
    borrowedCapitalMicroUsd,
    recordedAt,
  });
  return id;
}
