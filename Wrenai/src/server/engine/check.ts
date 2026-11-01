import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { currentAgentStrategy } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import { prepareSwapExecution } from "@/server/execution/intents-order";
import { databaseTime } from "@/server/execution/records";
import { advanceIntentsAction } from "./action";
import { planStrategyCheck, type StrategyCheckPlan } from "./planning";
import { claimStrategyCheck, finishStrategyCheck, readAgentRuntime } from "./runtime";

function slotRequestId(activationId: string, slot: number): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["rebalance-slot:v1", activationId, slot]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One bounded cycle; workflow history contains only IDs and the next polling delay. */
export async function checkAgentCycle(
  db: AppDatabase,
  activationId: string,
  runId: string,
): Promise<number | null> {
  const runtime = await readAgentRuntime(db, activationId);
  if (!runtime || runtime.workflowRunId !== runId) {
    return null;
  }
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, runtime.agentId), eq(agents.userId, runtime.userId)))
    .limit(1);
  const [pending] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, runtime.userId),
        eq(executionActions.agentId, runtime.agentId),
        isNull(executionActions.reservationReleasedAt),
      ),
    )
    .limit(1);
  if (pending) {
    return Math.min(
      await advanceIntentsAction(db, runtime.userId, pending.id),
      agent?.pack === "triggers" ? 5 : 60,
    );
  }
  if (agent?.status !== "running" || agent.revision !== runtime.agentRevision || runtime.state !== "active") {
    return null;
  }
  const claim = await claimStrategyCheck(db, activationId, runId);
  if (!claim) {
    return agent.pack === "triggers" ? 5 : 60;
  }
  const now = await databaseTime(db);
  let reason = "Within the reviewed allocation band.";
  let failed = false;
  let intervalSeconds = agent.pack === "triggers" ? 5 : 60;
  let actionId: string | null = null;
  let progress: StrategyCheckPlan["progress"];
  try {
    const current = await currentAgentStrategy(db, runtime.userId, runtime.agentId, runtime.agentRevision);
    const requestId = slotRequestId(activationId, claim.slot);
    const planned = await planStrategyCheck(db, current, runtime, requestId);
    intervalSeconds = planned.intervalSeconds;
    progress = planned.progress;
    reason = planned.reason;
    if (planned.signal) {
      const action = await prepareSwapExecution(db, runtime.userId, {
        requestId,
        agentId: runtime.agentId,
        expectedRevision: runtime.agentRevision,
        ...planned.signal,
      });
      actionId = action.id;
      if (progress) {
        progress = { ...progress, triggerState: { ...progress.triggerState, pendingActionId: action.id } };
      }
      reason =
        action.approvedAt === null
          ? "A reviewed trade needs your approval."
          : "Checking the reserved trade before submission.";
    }
  } catch (error) {
    if (
      !(error instanceof ExecutionError) &&
      !(error instanceof AgentError) &&
      !(error instanceof z.ZodError)
    ) {
      throw error;
    }
    reason =
      error instanceof z.ZodError
        ? "The reviewed strategy or provider data could not be validated."
        : error.message;
    failed = error instanceof z.ZodError || error.code === "not_ready";
  }
  await finishStrategyCheck(
    db,
    activationId,
    claim.token,
    Math.max(now + intervalSeconds * 1000, Date.now() + (agent.pack === "triggers" ? 5000 : 60_000)),
    reason,
    failed,
    progress,
  );
  if (progress?.completed) {
    return null;
  }
  return actionId === null
    ? agent.pack === "triggers"
      ? 5
      : 60
    : advanceIntentsAction(db, runtime.userId, actionId);
}
