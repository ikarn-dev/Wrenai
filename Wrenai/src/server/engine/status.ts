import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AgentError } from "@/server/agents/errors";
import { ownedAgent } from "@/server/agents/records";
import { agentRuntimes, agents } from "@/server/db/agent-schema";
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
  const [[row], pending] = await Promise.all([
    db
      .select({
        agent: {
          id: agents.id,
          status: agents.status,
          reason: agents.reason,
          revision: agents.revision,
          updatedAt: agents.updatedAt,
        },
        runtime: { state: agentRuntimes.state, nextCheckAt: agentRuntimes.nextCheckAt },
      })
      .from(agents)
      .leftJoin(
        agentRuntimes,
        and(eq(agentRuntimes.userId, agents.userId), eq(agentRuntimes.agentId, agents.id)),
      )
      .where(and(eq(agents.userId, userId), eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1),
    db
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
      .limit(10),
  ]);
  if (!row) {
    throw new AgentError("not_found", "Agent not found.");
  }
  return { ...row, pending };
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
