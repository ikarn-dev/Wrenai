import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { agentCapital, capitalAccounts } from "@/server/db/position-schema";
import { executionSubjects } from "@/server/db/subject-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";

export async function manualSubject(db: AppDatabase, userId: string): Promise<string> {
  return userTransaction(db, userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(executionSubjects)
      .where(and(eq(executionSubjects.userId, userId), eq(executionSubjects.kind, "manual")))
      .limit(1);
    if (existing) {
      return existing.id;
    }
    const id = randomUUID(),
      now = await databaseTime(tx);
    await tx.insert(executionSubjects).values({ id, userId, kind: "manual", agentId: null, createdAt: now });
    // Manual orders have exact per-confirmation bounds. These legacy metadata rows grant no budget.
    await tx
      .insert(capitalAccounts)
      .values({ userId, limitMicroUsd: 0n, updatedAt: now })
      .onConflictDoNothing();
    await tx.insert(agentCapital).values({ userId, agentId: id, limitMicroUsd: 0n, updatedAt: now });
    return id;
  });
}
export async function requireManualSubject(
  db: AppDatabase,
  userId: string,
  subjectId: string,
): Promise<void> {
  const [subject] = await db
    .select()
    .from(executionSubjects)
    .where(
      and(
        eq(executionSubjects.id, subjectId),
        eq(executionSubjects.userId, userId),
        eq(executionSubjects.kind, "manual"),
      ),
    )
    .limit(1);
  if (!subject) {
    throw new ExecutionError("not_found", "The manual trading account is unavailable.");
  }
}
