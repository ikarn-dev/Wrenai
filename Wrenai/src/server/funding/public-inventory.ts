import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { freshTradingBalances } from "@/server/execution/balances";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";

export async function synchronizePublicToken(
  db: AppDatabase,
  userId: string,
  accountId: string,
  assetId: string,
): Promise<void> {
  const token = await beginInventorySync(db, userId, "intents", [assetId]);
  const observed = await freshTradingBalances(db, userId, accountId, [assetId], "intents");
  await finishInventorySync(
    db,
    userId,
    {
      scope: "intents",
      syncToken: token,
      balances: observed.balances.map((balance) => ({
        assetId: balance.assetId,
        amountUnits: balance.units,
      })),
    },
    [assetId],
  );
}
