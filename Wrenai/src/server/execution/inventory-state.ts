import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionInventory } from "@/server/db/execution-schema";
import type { ExecutionScope } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { IN_FLIGHT, invalidateInventory, type LedgerAction, swapAction } from "./records";

export function actionCashAssets(action: LedgerAction): readonly string[] {
  if (action.kind === "swap") {
    const swap = swapAction(action);
    return [swap.inputAssetId, swap.outputAssetId];
  }
  return defiPlanSchema.parse(JSON.parse(action.planJson)).cash.map((asset) => asset.assetId);
}

export async function quarantinedAssets(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
): Promise<ReadonlySet<string>> {
  const pending = await db
    .select()
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.scope, scope),
        inArray(executionActions.status, IN_FLIGHT),
      ),
    );
  return new Set(pending.flatMap(actionCashAssets));
}

/** Unknown rows are marked unavailable, never presented as a confirmed zero balance. */
export async function markInventoryUncertain(db: AppDatabase, action: LedgerAction): Promise<void> {
  for (const assetId of actionCashAssets(action)) {
    await db
      .insert(executionInventory)
      .values({ userId: action.userId, scope: action.scope, assetId, balanceUnits: 0n, observedAt: null })
      .onConflictDoUpdate({
        target: [executionInventory.userId, executionInventory.scope, executionInventory.assetId],
        set: { observedAt: null },
      });
  }
  await invalidateInventory(db, action.userId, action.scope);
}
