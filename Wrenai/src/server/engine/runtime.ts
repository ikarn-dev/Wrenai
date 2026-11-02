import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { commandAgent } from "@/server/agents/mutations";
import { auditAgent, killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import { agentRuntimes, agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime, executionHash } from "@/server/execution/records";
import type { agentCommandSchema } from "@/shared/agents";
import {
  hasOpenTriggerPosition,
  type RuntimeStrategyState,
  runtimeStrategyStateSchema,
} from "./strategy-state";

export async function prepareAgentRuntime(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof agentCommandSchema>,
): Promise<string> {
  return userTransaction(db, userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentRuntimes)
      .where(eq(agentRuntimes.agentId, input.agentId))
      .limit(1);
    if (existing?.activationId === input.requestId) {
      if (existing.userId !== userId || existing.inputHash !== executionHash(input)) {
        throw new AgentError("conflict", "This activation request belongs to different settings.");
      }
      return existing.activationId;
    }
    const agent = await ownedAgent(tx, userId, input.agentId);
    if (
      agent.revision !== input.expectedRevision ||
      agent.status === "running" ||
      (await killSwitchEngaged(tx, userId))
    ) {
      throw new AgentError("conflict", "The agent changed, is already running, or the global stop is on.");
    }
    const [unresolved] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.agentId, input.agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (unresolved) {
      throw new AgentError("not_ready", "Reconcile existing actions before starting a new lifecycle.");
    }
    const now = await databaseTime(tx);
    if (
      existing?.strategyStateJson !== null &&
      existing?.strategyStateJson !== undefined &&
      existing.strategyVersion !== agent.version &&
      hasOpenTriggerPosition(existing.strategyStateJson)
    ) {
      throw new AgentError(
        "not_ready",
        "The previous trigger position must be closed before starting a different strategy version.",
      );
    }
    const values = {
      userId,
      agentId: agent.id,
      activationId: input.requestId,
      inputHash: executionHash(input),
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      workflowRunId: null,
      segment: 0,
      nextCheckAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      failures: 0,
      strategyStateJson: existing?.strategyVersion === agent.version ? existing.strategyStateJson : null,
      state: "starting" as const,
      createdAt: now,
      updatedAt: now,
    };
    await tx
      .insert(agentRuntimes)
      .values(values)
      .onConflictDoUpdate({ target: agentRuntimes.agentId, set: values });
    await auditAgent(tx, userId, agent.id, "runtime_requested", "Starting the durable trading lifecycle.");
    return input.requestId;
  });
}

export async function readAgentRuntime(
  db: AppDatabase,
  activationId: string,
): Promise<typeof agentRuntimes.$inferSelect | null> {
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.activationId, activationId))
    .limit(1);
  return runtime ?? null;
}

/** Only the first queued run can own a segment. Queue retries never create a second trading authority. */
export async function claimRuntimeSegment(
  db: AppDatabase,
  activationId: string,
  runId: string,
  segment: number,
): Promise<boolean> {
  const initial = await readAgentRuntime(db, activationId);
  if (!initial) {
    return false;
  }
  return userTransaction(db, initial.userId, async (tx) => {
    const row = await readAgentRuntime(tx, activationId);
    if (!row) {
      return false;
    }
    if (row.workflowRunId === runId && row.segment === segment) {
      return true;
    }
    if ((segment === 0 && row.workflowRunId !== null) || (segment > 0 && row.segment !== segment - 1)) {
      return false;
    }
    let revision = row.agentRevision;
    if (row.state === "starting") {
      if (segment !== 0) {
        return false;
      }
      await commandAgent(tx, row.userId, {
        requestId: activationId,
        agentId: row.agentId,
        expectedRevision: revision,
        command: "resume",
      });
      revision += 1;
    }
    await tx
      .update(agentRuntimes)
      .set({
        workflowRunId: runId,
        segment,
        agentRevision: revision,
        state: row.state === "starting" ? "active" : row.state,
        updatedAt: await databaseTime(tx),
      })
      .where(eq(agentRuntimes.agentId, row.agentId));
    return true;
  });
}

export async function claimStrategyCheck(
  db: AppDatabase,
  activationId: string,
  runId: string,
): Promise<{ readonly token: string; readonly slot: number } | null> {
  const initial = await readAgentRuntime(db, activationId);
  if (!initial) {
    return null;
  }
  return userTransaction(db, initial.userId, async (tx) => {
    const runtime = await readAgentRuntime(tx, activationId);
    const now = await databaseTime(tx);
    if (
      !runtime ||
      runtime.workflowRunId !== runId ||
      runtime.state !== "active" ||
      runtime.nextCheckAt > now ||
      (runtime.leaseExpiresAt !== null && runtime.leaseExpiresAt > now)
    ) {
      return null;
    }
    const agent = await ownedAgent(tx, runtime.userId, runtime.agentId);
    if (
      agent.status !== "running" ||
      agent.revision !== runtime.agentRevision ||
      agent.version !== runtime.strategyVersion ||
      (await killSwitchEngaged(tx, runtime.userId))
    ) {
      await tx
        .update(agentRuntimes)
        .set({ state: "stopped", updatedAt: now })
        .where(eq(agentRuntimes.agentId, runtime.agentId));
      return null;
    }
    const token = randomUUID();
    await tx
      .update(agentRuntimes)
      .set({ leaseToken: token, leaseExpiresAt: now + 90_000, updatedAt: now })
      .where(eq(agentRuntimes.agentId, runtime.agentId));
    return { token, slot: runtime.nextCheckAt };
  });
}

/** Persist the observed slot before reserving an order so a crash cannot lose its authorization state. */
export async function recordStrategyProgress(
  db: AppDatabase,
  activationId: string,
  token: string,
  state: RuntimeStrategyState,
): Promise<void> {
  const initial = await readAgentRuntime(db, activationId);
  if (!initial) {
    throw new ExecutionError("not_found", "The agent runtime is unavailable.");
  }
  await userTransaction(db, initial.userId, async (tx) => {
    const runtime = await readAgentRuntime(tx, activationId),
      now = await databaseTime(tx);
    const agent = await ownedAgent(tx, initial.userId, initial.agentId);
    if (
      !runtime ||
      runtime.leaseToken !== token ||
      runtime.leaseExpiresAt === null ||
      runtime.leaseExpiresAt <= now ||
      runtime.state !== "active" ||
      agent.status !== "running" ||
      agent.revision !== runtime.agentRevision ||
      agent.version !== runtime.strategyVersion
    ) {
      throw new ExecutionError("lease_lost", "This decision no longer owns the current agent lifecycle.");
    }
    await tx
      .update(agentRuntimes)
      .set({ strategyStateJson: JSON.stringify(runtimeStrategyStateSchema.parse(state)), updatedAt: now })
      .where(eq(agentRuntimes.agentId, runtime.agentId));
  });
}

export async function finishStrategyCheck(
  db: AppDatabase,
  activationId: string,
  token: string,
  nextCheckAt: number,
  reason: string,
  failed: boolean,
  progress?: { readonly strategyState: unknown; readonly completed: boolean },
): Promise<void> {
  const initial = await readAgentRuntime(db, activationId);
  if (!initial) {
    return;
  }
  await userTransaction(db, initial.userId, async (tx) => {
    const runtime = await readAgentRuntime(tx, activationId);
    const now = await databaseTime(tx);
    if (
      !runtime ||
      runtime.leaseToken !== token ||
      runtime.leaseExpiresAt === null ||
      runtime.leaseExpiresAt <= now
    ) {
      throw new ExecutionError("lease_lost", "The strategy check belongs to another worker.");
    }
    const failures = failed ? runtime.failures + 1 : 0;
    const complete = progress?.completed === true;
    await tx
      .update(agentRuntimes)
      .set({
        nextCheckAt,
        failures,
        leaseToken: null,
        leaseExpiresAt: null,
        state: failures >= 3 ? "blocked" : complete ? "stopped" : runtime.state,
        ...(progress
          ? { strategyStateJson: JSON.stringify(runtimeStrategyStateSchema.parse(progress.strategyState)) }
          : {}),
        updatedAt: now,
      })
      .where(eq(agentRuntimes.agentId, runtime.agentId));
    await tx
      .update(agents)
      .set({
        reason,
        ...(failures >= 3
          ? { status: "error" as const }
          : complete
            ? { status: "stopped" as const, revision: runtime.agentRevision + 1 }
            : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, runtime.agentId),
          eq(agents.userId, runtime.userId),
          eq(agents.revision, runtime.agentRevision),
          eq(agents.status, "running"),
        ),
      );
    if (failed) {
      await auditAgent(tx, runtime.userId, runtime.agentId, "strategy_check_failed", reason);
    }
  });
}

export async function failAgentRuntime(db: AppDatabase, activationId: string, runId: string): Promise<void> {
  const initial = await readAgentRuntime(db, activationId);
  if (!initial) {
    return;
  }
  await userTransaction(db, initial.userId, async (tx) => {
    const row = await readAgentRuntime(tx, activationId);
    if (!row || (row.workflowRunId !== null && row.workflowRunId !== runId)) {
      return;
    }
    const now = await databaseTime(tx);
    if (await killSwitchEngaged(tx, row.userId)) {
      await tx
        .update(agentRuntimes)
        .set({ state: "stopped", leaseToken: null, leaseExpiresAt: null, updatedAt: now })
        .where(eq(agentRuntimes.agentId, row.agentId));
      return;
    }
    const reason =
      "Trading checks stopped after bounded retries. Unresolved funds remain reserved; reconcile before restarting.";
    await tx
      .update(agentRuntimes)
      .set({ state: "blocked", leaseToken: null, leaseExpiresAt: null, updatedAt: now })
      .where(eq(agentRuntimes.agentId, row.agentId));
    await tx
      .update(agents)
      .set({ status: "error", reason, updatedAt: now, revision: row.agentRevision + 1 })
      .where(
        and(
          eq(agents.id, row.agentId),
          eq(agents.userId, row.userId),
          eq(agents.revision, row.agentRevision),
        ),
      );
    await auditAgent(tx, row.userId, row.agentId, "runtime_failed", reason);
  });
}
