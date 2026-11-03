import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { databaseTime, executionEvent, type LedgerAction, ownedLedgerAction } from "../records";

export async function confirmedProtectionIndex(db: AppDatabase, action: LedgerAction): Promise<number> {
  const [row] = await db
    .select({ index: sql<number | null>`max((${executionEvents.detailJson}::jsonb ->> 'index')::integer)` })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "hl_protection_confirmed"),
      ),
    );
  return z
    .number()
    .int()
    .min(-1)
    .parse(row?.index ?? -1);
}
/** Reset the consecutive-attempt budget only after an actual native stop is observed covering the position. */
export async function recordConfirmedProtection(
  db: AppDatabase,
  action: LedgerAction,
  index: number,
): Promise<void> {
  await userTransaction(db, action.userId, async (tx) => {
    const source = await ownedLedgerAction(tx, action.userId, action.id);
    if (index <= (await confirmedProtectionIndex(tx, source))) {
      return;
    }
    await executionEvent(tx, source, "hl_protection_confirmed", await databaseTime(tx), { index });
  });
}
