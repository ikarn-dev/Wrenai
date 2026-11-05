import "server-only";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { agentEvents, agents, strategyVersions, tradingControls } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { type AgentSummary, policySchema, strategySchema } from "@/shared/agents";
import { AgentError } from "./errors";

export async function ownedAgent(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<typeof agents.$inferSelect> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (row === undefined) {
    throw new AgentError("not_found", "Agent not found.");
  }
  return row;
}

function summarize(
  row: typeof agents.$inferSelect,
  version: typeof strategyVersions.$inferSelect | null | undefined,
): AgentSummary {
  if (version === undefined || version === null) {
    throw new AgentError("unavailable", "The strategy version is missing. This agent cannot run.");
  }
  return {
    id: row.id,
    name: row.name,
    pack: row.pack,
    status: row.status,
    reason: row.reason,
    revision: row.revision,
    version: row.version,
    strategyText: version.strategyText,
    strategy: strategySchema.parse(JSON.parse(version.configJson)),
    policy: policySchema.parse(JSON.parse(row.policyJson)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function agentSummary(db: AppDatabase, row: typeof agents.$inferSelect): Promise<AgentSummary> {
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(and(eq(strategyVersions.agentId, row.id), eq(strategyVersions.version, row.version)))
    .limit(1);
  return summarize(row, version);
}

function agentsWithVersion(db: AppDatabase) {
  return db
    .select({ agent: agents, strategy: strategyVersions })
    .from(agents)
    .leftJoin(
      strategyVersions,
      and(eq(strategyVersions.agentId, agents.id), eq(strategyVersions.version, agents.version)),
    );
}

export async function ownedAgentSummary(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentSummary> {
  const [row] = await agentsWithVersion(db)
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!row) {
    throw new AgentError("not_found", "Agent not found.");
  }
  return summarize(row.agent, row.strategy);
}

/** Fetch versions in one query instead of one network round trip per card. */
export async function listAgents(db: AppDatabase, userId: string): Promise<readonly AgentSummary[]> {
  const rows = await agentsWithVersion(db)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
    .orderBy(desc(agents.createdAt));
  return rows.map(({ agent, strategy }) => summarize(agent, strategy));
}

export async function auditAgent(
  db: AppDatabase,
  userId: string,
  agentId: string | null,
  kind: string,
  message: string,
  detail: unknown = {},
): Promise<void> {
  await db.insert(agentEvents).values({
    id: crypto.randomUUID(),
    userId,
    agentId,
    kind,
    message,
    detailJson: JSON.stringify(detail),
    createdAt: Date.now(),
  });
}

export async function readTradingControls(
  db: AppDatabase,
  userId: string,
): Promise<{ readonly engaged: boolean; readonly revision: number }> {
  const [row] = await db.select().from(tradingControls).where(eq(tradingControls.userId, userId)).limit(1);
  return { engaged: row?.killSwitch ?? false, revision: row?.updatedAt ?? 0 };
}

export async function killSwitchEngaged(db: AppDatabase, userId: string): Promise<boolean> {
  return (await readTradingControls(db, userId)).engaged;
}

export async function globalStopRevision(db: AppDatabase, userId: string): Promise<number> {
  return (await readTradingControls(db, userId)).revision;
}

export async function stopUserAgents(db: AppDatabase, userId: string, reason: string): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const now = Date.now();
    const rows = await tx
      .update(agents)
      .set({ status: "stopped", reason, revision: sql`${agents.revision} + 1`, updatedAt: now })
      .where(and(eq(agents.userId, userId), isNull(agents.deletedAt), ne(agents.status, "stopped")))
      .returning({ id: agents.id });
    if (rows.length > 0) {
      await tx.insert(agentEvents).values(
        rows.map((agent) => ({
          id: crypto.randomUUID(),
          userId,
          agentId: agent.id,
          kind: "stopped",
          message: reason,
          detailJson: "{}",
          createdAt: now,
        })),
      );
    }
  });
}
