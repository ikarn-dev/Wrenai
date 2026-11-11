import { and, eq } from "drizzle-orm";
import { FatalError, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { advanceAgentReturn } from "@/server/agents/agent-return";
import { agentEvents, agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";

// About eight hours of five-second checks; after that the owner presses Claim or Delete again.
const MAX_SEGMENTS = 48;

async function claimSegment(
  userId: string,
  agentId: string,
  trackingId: string,
  segment: number,
  runId: string,
): Promise<boolean> {
  "use step";
  z.uuid().parse(agentId);
  z.uuid().parse(trackingId);
  z.number().int().nonnegative().max(MAX_SEGMENTS).parse(segment);
  const kind = `agent_return_poll_${trackingId}_${segment}`;
  return userTransaction(database(), userId, async (tx) => {
    const [existing] = await tx
      .select({ detail: agentEvents.detailJson })
      .from(agentEvents)
      .where(
        and(eq(agentEvents.userId, userId), eq(agentEvents.agentId, agentId), eq(agentEvents.kind, kind)),
      )
      .limit(1);
    if (existing) {
      return z.object({ runId: z.string() }).parse(JSON.parse(existing.detail)).runId === runId;
    }
    await tx.insert(agentEvents).values({
      id: crypto.randomUUID(),
      userId,
      agentId,
      kind,
      message: "Checking the claim or delete.",
      detailJson: JSON.stringify({ runId }),
      createdAt: Date.now(),
    });
    return true;
  });
}
async function returnStep(userId: string, agentId: string): Promise<{ done: boolean; seconds: number }> {
  "use step";
  const step = await advanceAgentReturn(database(), userId, agentId);
  if (step.kind === "blocked") {
    await recordPause(userId, agentId, step.reason);
    return { done: true, seconds: 0 };
  }
  return { done: step.kind === "done", seconds: step.kind === "wait" ? step.seconds : 0 };
}
async function recordPause(userId: string, agentId: string, reason: string): Promise<void> {
  await database()
    .update(agents)
    .set({ reason, updatedAt: Date.now() })
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId)));
}
async function recordInterrupted(userId: string, agentId: string): Promise<void> {
  "use step";
  await recordPause(
    userId,
    agentId,
    "Paused. Press Claim or Delete again to continue. Funds already sent stay tracked.",
  );
}
claimSegment.maxRetries = 3;
returnStep.maxRetries = 3;
recordInterrupted.maxRetries = 3;

/** A claim (send every held token to the wallet) or a delete (finish once nothing is held). Durable polling. */
export async function runAgentReturn(
  userId: string,
  agentId: string,
  trackingId: string,
  segment = 0,
): Promise<void> {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    if (!(await claimSegment(userId, agentId, trackingId, segment, workflowRunId))) {
      return;
    }
    for (let tick = 0; tick < 120; tick += 1) {
      const step = await returnStep(userId, agentId);
      if (step.done) {
        return;
      }
      await sleep(step.seconds * 1000);
    }
    if (segment + 1 >= MAX_SEGMENTS) {
      await recordInterrupted(userId, agentId);
      return;
    }
    await start(runAgentReturn, [userId, agentId, trackingId, segment + 1]);
  } catch {
    await recordInterrupted(userId, agentId);
    throw new FatalError("The claim or delete stopped. Press it again to continue.");
  }
}
