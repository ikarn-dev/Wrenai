import "server-only";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { requireManualSubject } from "./subject";

export async function manualReturnSource(
  db: AppDatabase,
  userId: string,
  subjectId: string,
  actionId?: string,
): Promise<{ account: NonNullable<Awaited<ReturnType<typeof readAgentTradingAccount>>> }> {
  await requireManualSubject(db, userId, subjectId);
  const account = await readAgentTradingAccount(db, userId, subjectId),
    root = await activeTradingAccount(db, userId);
  if (!account || !root?.backupConfirmedAt || root.id !== account.rootId || root.backupVersion < 2) {
    throw new ExecutionError("not_ready", "The backed-up manual Perps account is unavailable.");
  }
  const [exposure] = await db
    .select({ id: defiPositions.id })
    .from(defiPositions)
    .where(
      and(
        eq(defiPositions.userId, userId),
        eq(defiPositions.agentId, subjectId),
        gt(defiPositions.quantityUnits, 0n),
      ),
    )
    .limit(1);
  const [pending] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, subjectId),
        isNull(executionActions.reservationReleasedAt),
        actionId ? ne(executionActions.id, actionId) : undefined,
      ),
    )
    .limit(1);
  if (exposure || pending) {
    throw new ExecutionError(
      "not_ready",
      "Close your position and reconcile pending orders before returning funds.",
    );
  }
  return { account };
}
