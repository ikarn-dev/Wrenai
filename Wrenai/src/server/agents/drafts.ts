import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { attestationReceiptSchema } from "@/server/ai/attestation-receipt";
import { parseAttestedStrategy } from "@/server/ai/strategy-parser";
import { strategyDrafts, strategyParseJobs } from "@/server/db/agent-schema";
import { type AppDatabase, database } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { budgetFundingAsset } from "@/shared/agent-budget";
import { instructionFundingAsset } from "@/shared/agent-instructions";
import { type parseStrategyInputSchema, type StrategyDraft, strategySchema } from "@/shared/agents";
import { AgentError } from "./errors";
import { auditAgent } from "./records";

type ParseInput = z.infer<typeof parseStrategyInputSchema>;
const databaseNow = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const LEASE_MS = 120_000;

function toDraft(row: typeof strategyDrafts.$inferSelect, input: ParseInput): StrategyDraft {
  const strategy = strategySchema.parse(JSON.parse(row.configJson));
  if (
    row.pack !== input.pack ||
    row.strategyText !== input.strategyText ||
    (input.budget &&
      "format" in strategy &&
      instructionFundingAsset(strategy) !== budgetFundingAsset(input.budget.assetId)) ||
    row.consumedAt !== null ||
    row.expiresAt <= Date.now()
  ) {
    throw new AgentError("conflict", "This review request was already used or expired. Try parsing again.");
  }
  const receipt = attestationReceiptSchema.parse(JSON.parse(row.attestationJson));
  return {
    id: row.id,
    strategy,
    strategyText: row.strategyText,
    model: receipt.model,
    verifiedAt: receipt.verifiedAt,
    expiresAt: row.expiresAt,
  };
}

async function savedDraft(
  db: AppDatabase,
  userId: string,
  requestId: string,
): Promise<typeof strategyDrafts.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(strategyDrafts)
    .where(and(eq(strategyDrafts.userId, userId), eq(strategyDrafts.requestId, requestId)))
    .limit(1);
  return row;
}

async function claimParse(
  userId: string,
  input: ParseInput,
  leaseToken: string,
): Promise<StrategyDraft | null> {
  return userTransaction(database(), userId, async (tx) => {
    const existing = await savedDraft(tx, userId, input.requestId);
    if (existing !== undefined) {
      return toDraft(existing, input);
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify({ pack: input.pack, text: input.strategyText, budgetAssetId: input.budget?.assetId }),
      )
      .digest("hex");
    const [job] = await tx
      .select()
      .from(strategyParseJobs)
      .where(and(eq(strategyParseJobs.userId, userId), eq(strategyParseJobs.requestId, input.requestId)))
      .limit(1);
    if (job !== undefined && job.inputHash !== hash) {
      throw new AgentError("conflict", "This review request is already parsing a different strategy.");
    }
    const claimed = await tx
      .insert(strategyParseJobs)
      .values({
        id: randomUUID(),
        userId,
        requestId: input.requestId,
        inputHash: hash,
        leaseToken,
        leaseExpiresAt: sql`${databaseNow} + ${LEASE_MS}`,
      })
      .onConflictDoUpdate({
        target: [strategyParseJobs.userId, strategyParseJobs.requestId],
        set: { leaseToken, leaseExpiresAt: sql`${databaseNow} + ${LEASE_MS}` },
        setWhere: sql`${strategyParseJobs.leaseExpiresAt} <= ${databaseNow}`,
      })
      .returning({ id: strategyParseJobs.id });
    if (claimed.length === 0) {
      throw new AgentError(
        "in_progress",
        "This strategy is already being verified. Wait for its result, then try again.",
      );
    }
    return null;
  });
}

export async function prepareStrategyDraft(userId: string, input: ParseInput): Promise<StrategyDraft> {
  const existing = await savedDraft(database(), userId, input.requestId);
  if (existing !== undefined) {
    return toDraft(existing, input);
  }
  const leaseToken = randomUUID();
  const saved = await claimParse(userId, input, leaseToken);
  if (saved !== null) {
    return saved;
  }
  try {
    const { strategy, receipt } = await parseAttestedStrategy(
      input.pack,
      input.strategyText,
      input.budget?.assetId,
    );
    return await userTransaction(database(), userId, async (tx) => {
      const [lease] = await tx
        .select()
        .from(strategyParseJobs)
        .where(
          and(
            eq(strategyParseJobs.userId, userId),
            eq(strategyParseJobs.requestId, input.requestId),
            eq(strategyParseJobs.leaseToken, leaseToken),
            sql`${strategyParseJobs.leaseExpiresAt} > ${databaseNow}`,
          ),
        )
        .limit(1);
      if (lease === undefined) {
        throw new AgentError("conflict", "Strategy verification expired. Parse it again.");
      }
      const now = Date.now();
      const [stored] = await tx
        .insert(strategyDrafts)
        .values({
          id: randomUUID(),
          userId,
          requestId: input.requestId,
          pack: input.pack,
          strategyText: input.strategyText,
          configJson: JSON.stringify(strategy),
          attestationJson: JSON.stringify(receipt),
          createdAt: now,
          expiresAt: now + 30 * 60_000,
        })
        .returning();
      if (stored === undefined) {
        throw new Error("The verified strategy was not stored.");
      }
      await auditAgent(
        tx,
        userId,
        null,
        "strategy_parsed",
        "Strategy parsed with a verified model response.",
        {
          draftId: stored.id,
          ...receipt,
        },
      );
      return toDraft(stored, input);
    });
  } finally {
    await database()
      .delete(strategyParseJobs)
      .where(
        and(
          eq(strategyParseJobs.userId, userId),
          eq(strategyParseJobs.requestId, input.requestId),
          eq(strategyParseJobs.leaseToken, leaseToken),
        ),
      );
  }
}
