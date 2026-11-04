import { and, eq } from "drizzle-orm";
import { FatalError, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { databaseTime, executionEvent, ownedLedgerAction } from "@/server/execution/records";
import { advanceFundingRecord } from "@/server/funding/progress";
import { ownedWalletFunding } from "@/server/funding/records";

async function claimSegment(
  owner: string,
  fundingId: string,
  trackingId: string,
  segment: number,
  runId: string,
): Promise<boolean> {
  "use step";
  z.number().int().min(0).max(432).parse(segment);
  z.uuid().parse(trackingId);
  return userTransaction(database(), owner, async (tx) => {
    const row = await ownedWalletFunding(tx, owner, fundingId);
    if (row.state !== "converting" || !row.actionId) {
      return false;
    }
    const action = await ownedLedgerAction(tx, owner, row.actionId),
      kind = `wallet_funding_poll_${trackingId}_${segment}`;
    const [existing] = await tx
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.userId, owner),
          eq(executionEvents.actionId, action.id),
          eq(executionEvents.kind, kind),
        ),
      )
      .limit(1);
    if (existing) {
      return z.object({ runId: z.string() }).parse(JSON.parse(existing.detailJson)).runId === runId;
    }
    await executionEvent(tx, action, kind, await databaseTime(tx), { runId });
    return true;
  });
}
async function advance(owner: string, fundingId: string): Promise<boolean> {
  "use step";
  return advanceFundingRecord(database(), owner, fundingId);
}
async function recordFailure(owner: string, fundingId: string): Promise<void> {
  "use step";
  await userTransaction(database(), owner, async (tx) => {
    const row = await ownedWalletFunding(tx, owner, fundingId),
      now = await databaseTime(tx);
    await tx
      .update(agents)
      .set({ reason: "Funding needs a status check. No second wallet transfer is required.", updatedAt: now })
      .where(and(eq(agents.userId, owner), eq(agents.id, row.agentId)));
  });
}
claimSegment.maxRetries = 3;
advance.maxRetries = 3;
recordFailure.maxRetries = 3;

export async function runWalletFunding(
  owner: string,
  fundingId: string,
  trackingId: string,
  segment = 0,
): Promise<void> {
  "use workflow";
  try {
    if (!(await claimSegment(owner, fundingId, trackingId, segment, getWorkflowMetadata().workflowRunId))) {
      return;
    }
    for (let tick = 0; tick < 120; tick += 1) {
      if (!(await advance(owner, fundingId))) {
        return;
      }
      await sleep(5000);
    }
    if (segment >= 431) {
      throw new FatalError("Funding is still unresolved after the provider validity window.");
    }
    await start(runWalletFunding, [owner, fundingId, trackingId, segment + 1]);
  } catch {
    await recordFailure(owner, fundingId);
    throw new FatalError(
      "Funding needs reconciliation. Keep the deposit receipt; no duplicate transfer was made.",
    );
  }
}
