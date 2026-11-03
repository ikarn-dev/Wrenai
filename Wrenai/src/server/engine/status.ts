import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import type { AgentRuntimeStatus } from "@/shared/agent-runtime";
import { advanceLedgerAction } from "./ledger-action";

export async function agentRuntimeStatus(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentRuntimeStatus> {
  const agent = await ownedAgent(db, userId, agentId);
  const [runtime] = await db
    .select({ state: agentRuntimes.state, nextCheckAt: agentRuntimes.nextCheckAt })
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, agentId)))
    .limit(1);
  const pending = await db
    .select({
      id: executionActions.id,
      status: executionActions.status,
      startedAt: executionActions.startedAt,
    })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        isNull(executionActions.reservationReleasedAt),
      ),
    )
    .orderBy(asc(executionActions.createdAt), asc(executionActions.id))
    .limit(10);
  return {
    agent: {
      id: agent.id,
      status: agent.status,
      reason: agent.reason,
      revision: agent.revision,
      updatedAt: agent.updatedAt,
    },
    runtime: runtime ?? null,
    pending,
  };
}

/** User-triggered recovery cannot produce a new signature or resubmit an ambiguous order. */
export async function reconcileAgentOrders(db: AppDatabase, userId: string, agentId: string): Promise<void> {
  const snapshot = await agentRuntimeStatus(db, userId, agentId);
  for (const action of snapshot.pending) {
    await advanceLedgerAction(db, userId, action.id, "reconcile_only");
  }
  if (snapshot.pending.length === 0) {
    const agent = await ownedAgent(db, userId, agentId);
    if (agent.pack === "perps") {
      await watchPerpsPosition(db, userId, agentId, false);
    }
  }
}
