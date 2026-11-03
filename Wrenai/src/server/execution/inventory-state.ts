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
export function actionCashLocations(
  action: LedgerAction,
): readonly { readonly scope: ExecutionScope; readonly assetId: string }[] {
  if (action.kind === "swap") {
    return actionCashAssets(action).map((assetId) => ({ scope: action.scope, assetId }));
  }
  return defiPlanSchema
    .parse(JSON.parse(action.planJson))
    .cash.map((cash) => ({ scope: cash.scope ?? action.scope, assetId: cash.assetId }));
}

export async function quarantinedAssets(
  db: AppDatabase,
  userId: string,
  scope: ExecutionScope,
): Promise<ReadonlySet<string>> {
  const pending = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), inArray(executionActions.status, IN_FLIGHT)));
  return new Set(
    pending
      .flatMap(actionCashLocations)
      .filter((location) => location.scope === scope)
      .map((location) => location.assetId),
  );
}

/** Unknown rows are marked unavailable, never presented as a confirmed zero balance. */
export async function markInventoryUncertain(db: AppDatabase, action: LedgerAction): Promise<void> {
  const locations = actionCashLocations(action);
  for (const { assetId, scope } of locations) {
    await db
      .insert(executionInventory)
      .values({ userId: action.userId, scope, assetId, balanceUnits: 0n, observedAt: null })
      .onConflictDoUpdate({
        target: [executionInventory.userId, executionInventory.scope, executionInventory.assetId],
        set: { observedAt: null, syncToken: null, syncExpiresAt: null },
      });
  }
  for (const scope of new Set(locations.map((location) => location.scope))) {
    await invalidateInventory(db, action.userId, scope);
  }
}
