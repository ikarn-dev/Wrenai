import { and, eq } from "drizzle-orm";
import { FatalError, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { databaseTime, executionEvent, ownedLedgerAction } from "@/server/execution/records";

async function claimSegment(
  userId: string,
  actionId: string,
  segment: number,
  runId: string,
): Promise<boolean> {
  "use step";
  const db = database();
  z.uuid().parse(actionId);
  z.number().int().nonnegative().safe().parse(segment);
  return userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    if (
      !defiPlanSchema.parse(JSON.parse(action.planJson)).returnFunds ||
      action.reservationReleasedAt !== null
    ) {
      return false;
    }
    const kind = `perps_return_poll_${segment}`;
    const [existing] = await tx
      .select({ detail: executionEvents.detailJson })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.userId, userId),
          eq(executionEvents.actionId, actionId),
          eq(executionEvents.kind, kind),
        ),
      )
      .limit(1);
    if (existing) {
      return z.object({ runId: z.string() }).parse(JSON.parse(existing.detail)).runId === runId;
    }
    await executionEvent(tx, action, kind, await databaseTime(tx), { runId });
    return true;
  });
}
async function reconcileCycle(userId: string, actionId: string): Promise<boolean> {
  "use step";
  const db = database();
  await advanceLedgerAction(db, userId, actionId, "reconcile_only");
  return (await ownedLedgerAction(db, userId, actionId)).reservationReleasedAt === null;
}
claimSegment.maxRetries = 3;
reconcileCycle.maxRetries = 3;
async function recordFailure(userId: string, actionId: string): Promise<void> {
  "use step";
  await userTransaction(database(), userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    if (action.reservationReleasedAt !== null) {
      return;
    }
    const now = await databaseTime(tx);
    await executionEvent(tx, action, "perps_return_tracking_interrupted", now);
    await tx
      .update(agents)
      .set({
        reason: "Return tracking paused. Use Check orders; submitted funds remain reserved.",
        updatedAt: now,
      })
      .where(and(eq(agents.userId, userId), eq(agents.id, action.agentId)));
  });
}
recordFailure.maxRetries = 3;

/** A paused agent still needs durable reconciliation of its already submitted withdrawal. */
export async function runPerpsReturn(userId: string, actionId: string, segment = 0): Promise<void> {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    if (!(await claimSegment(userId, actionId, segment, workflowRunId))) {
      return;
    }
    for (let tick = 0; tick < 120; tick += 1) {
      if (!(await reconcileCycle(userId, actionId))) {
        return;
      }
      await sleep(5000);
    }
    await start(runPerpsReturn, [userId, actionId, segment + 1]);
  } catch {
    await recordFailure(userId, actionId);
    throw new FatalError(
      "The return needs reconciliation. Funds remain reserved; use Check orders on the agent.",
    );
  }
}
