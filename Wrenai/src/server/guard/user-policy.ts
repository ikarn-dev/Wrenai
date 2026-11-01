import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import type { AppDatabase } from "@/server/db/client";
import { userRiskPolicies } from "@/server/db/risk-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { databaseTime, executionHash } from "@/server/execution/records";
import { parseUsd } from "@/shared/agents";
import {
  saveUserRiskPolicySchema,
  type UserRiskPolicyRecord,
  userRiskPolicySchema,
} from "@/shared/risk-policy";

// Verify historical hashes without rewriting append-only records or exposing obsolete selectors.
const storedPolicySchema = z.union([
  userRiskPolicySchema,
  userRiskPolicySchema.extend({
    allowedAssetIds: z.array(z.string()).transform((ids) => ids.toSorted()),
    allowedChains: z.array(z.string()).transform((ids) => ids.toSorted()),
  }),
]);

function policyRecord(row: typeof userRiskPolicies.$inferSelect): UserRiskPolicyRecord {
  let rawPolicy: unknown;
  try {
    rawPolicy = JSON.parse(row.policyJson);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new AgentError("unavailable", "The stored risk policy cannot be read. Trading remains blocked.");
  }
  const parsed = storedPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) {
    throw new AgentError("unavailable", "The stored risk policy is invalid. Trading remains blocked.");
  }
  const policy = parsed.data;
  if (executionHash(policy) !== row.policyHash || parseUsd(policy.dailyCapUsd) !== row.dailyCapMicroUsd) {
    throw new AgentError("unavailable", "The stored risk policy is inconsistent. Trading remains blocked.");
  }
  return { revision: row.revision, policy: { dailyCapUsd: policy.dailyCapUsd }, updatedAt: row.createdAt };
}

export async function readUserRiskPolicy(
  db: AppDatabase,
  userId: string,
): Promise<UserRiskPolicyRecord | null> {
  const [row] = await db
    .select()
    .from(userRiskPolicies)
    .where(eq(userRiskPolicies.userId, userId))
    .orderBy(desc(userRiskPolicies.revision))
    .limit(1);
  return row === undefined ? null : policyRecord(row);
}

/** userId comes from the authenticated owner; neither models nor providers can configure this policy. */
export async function setUserRiskPolicy(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<UserRiskPolicyRecord> {
  const input = saveUserRiskPolicySchema.parse(raw);
  const requestHash = executionHash(input);
  return userTransaction(db, userId, async (tx) => {
    const [repeated] = await tx
      .select()
      .from(userRiskPolicies)
      .where(and(eq(userRiskPolicies.userId, userId), eq(userRiskPolicies.requestId, input.requestId)))
      .limit(1);
    if (repeated !== undefined) {
      if (repeated.requestHash !== requestHash) {
        throw new AgentError("conflict", "This risk-policy request already belongs to different settings.");
      }
      return policyRecord(repeated);
    }
    const current = await readUserRiskPolicy(tx, userId);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new AgentError(
        "conflict",
        "Your account-wide limits changed. Review the current settings first.",
      );
    }
    const now = await databaseTime(tx);
    const [stored] = await tx
      .insert(userRiskPolicies)
      .values({
        userId,
        revision: input.expectedRevision + 1,
        requestId: input.requestId,
        requestHash,
        policyHash: executionHash(input.policy),
        policyJson: JSON.stringify(input.policy),
        dailyCapMicroUsd: parseUsd(input.policy.dailyCapUsd),
        createdAt: now,
      })
      .returning();
    if (stored === undefined) {
      throw new Error("The account-wide risk policy was not stored.");
    }
    return policyRecord(stored);
  });
}
