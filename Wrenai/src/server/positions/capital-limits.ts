import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { agentCapital, capitalAccounts } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";
import { parseUsd, policySchema } from "@/shared/agents";
import { committedCapital, recordCapitalEvent, repeatedCapitalRequest } from "./capital-records";
import { agentCapitalLimitSchema, capitalLimitSchema } from "./contracts";

/** Historical capital-import compatibility. Current funding never uses a user-entered shared cap. */
export async function setUserCapitalLimit(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = capitalLimitSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    if ((await repeatedCapitalRequest(tx, userId, input.requestId, "user_limit", input)) !== undefined) {
      return;
    }
    const [assigned] = await tx
      .select({ amount: sql<string>`coalesce(sum(${agentCapital.limitMicroUsd}), 0)::text` })
      .from(agentCapital)
      .where(eq(agentCapital.userId, userId));
    const limit = BigInt(input.amountMicroUsd);
    if (limit < BigInt(assigned?.amount ?? "0")) {
      throw new ExecutionError(
        "limit",
        "Reduce agent allocations before lowering the shared user capital limit.",
      );
    }
    const now = await databaseTime(tx);
    await tx
      .insert(capitalAccounts)
      .values({ userId, limitMicroUsd: limit, updatedAt: now })
      .onConflictDoUpdate({ target: capitalAccounts.userId, set: { limitMicroUsd: limit, updatedAt: now } });
    await recordCapitalEvent(tx, userId, null, input.requestId, "user_limit", input, userId, now);
  });
}

export async function setAgentCapitalLimit(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = agentCapitalLimitSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    if ((await repeatedCapitalRequest(tx, userId, input.requestId, "agent_limit", input)) !== undefined) {
      return;
    }
    const agent = await ownedAgent(tx, userId, input.agentId);
    const policy = policySchema.parse(JSON.parse(agent.policyJson));
    const limit = BigInt(input.amountMicroUsd);
    const [others] = await tx
      .select({ amount: sql<string>`coalesce(sum(${agentCapital.limitMicroUsd}), 0)::text` })
      .from(agentCapital)
      .where(and(eq(agentCapital.userId, userId), ne(agentCapital.agentId, input.agentId)));
    if (limit > parseUsd(policy.budgetUsd) || limit < (await committedCapital(tx, userId, input.agentId))) {
      throw new ExecutionError(
        "limit",
        "The allocation exceeds a saved ceiling or would abandon attributed capital.",
      );
    }
    const now = await databaseTime(tx);
    // Retain the existing FK/records, but this is a derived total, not permission to spend wallet funds.
    const total = limit + BigInt(others?.amount ?? "0");
    await tx
      .insert(capitalAccounts)
      .values({ userId, limitMicroUsd: total, updatedAt: now })
      .onConflictDoUpdate({ target: capitalAccounts.userId, set: { limitMicroUsd: total, updatedAt: now } });
    await tx
      .insert(agentCapital)
      .values({ userId, agentId: input.agentId, limitMicroUsd: limit, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentCapital.userId, agentCapital.agentId],
        set: { limitMicroUsd: limit, updatedAt: now },
      });
    await recordCapitalEvent(
      tx,
      userId,
      input.agentId,
      input.requestId,
      "agent_limit",
      input,
      input.agentId,
      now,
    );
  });
}
