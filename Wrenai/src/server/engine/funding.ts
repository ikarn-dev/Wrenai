import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import { agentEvents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { tradePreviews } from "@/server/db/preview-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { freshDryQuote } from "@/server/execution/oneclick-quote";
import { tradePreviewSnapshot } from "@/server/execution/preview";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash } from "@/server/execution/records";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit, setUserCapitalLimit } from "@/server/positions/capital-limits";
import { agentFundingSchema } from "@/shared/agent-funding";
import { parseUsd } from "@/shared/agents";

function requestPart(requestId: string, kind: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["funding-request:v1", requestId, kind]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function repeatedFunding(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof agentFundingSchema>,
): Promise<boolean> {
  const [event] = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.id, input.requestId), eq(agentEvents.userId, userId)))
    .limit(1);
  if (!event) {
    return false;
  }
  if (
    event.kind !== "capital_reviewed" ||
    event.detailJson !== JSON.stringify({ inputHash: executionHash(input) })
  ) {
    throw new ExecutionError("conflict", "This funding request belongs to a different allocation.");
  }
  return true;
}

/** Assign only the exact reviewed input units. This does not transfer funds or invent historical cost basis. */
export async function allocatePreviewBalance(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = agentFundingSchema.parse(raw);
  if (await repeatedFunding(db, userId, input)) {
    return;
  }
  const [row] = await db
    .select()
    .from(tradePreviews)
    .where(and(eq(tradePreviews.id, input.previewId), eq(tradePreviews.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "The reviewed balance does not belong to this account.");
  }
  const preview = tradePreviewSnapshot(row);
  const quote = preview.quote;
  if (!quote?.inputMicroUsd || quote.scope !== "confidential" || preview.balance.status !== "verified") {
    throw new ExecutionError(
      "not_ready",
      "A fresh signed quote and verified private balance are required for allocation.",
    );
  }
  if (Date.now() - preview.createdAt >= 300_000) {
    throw new ExecutionError(
      "not_ready",
      "Request a fresh balance preview before reviewing this allocation.",
    );
  }
  const fresh = await Promise.allSettled([
    synchronizePrivateInventory(db, userId),
    freshDryQuote(
      quote.recipient,
      quote.inputAssetId,
      quote.outputAssetId,
      quote.inputUnits,
      quote.slippageBps,
      "confidential",
    ),
  ]);
  const inventory = fresh[0];
  const priced = fresh[1];
  if (
    inventory?.status !== "fulfilled" ||
    !priced ||
    priced.status !== "fulfilled" ||
    priced.value.inputMicroUsd === null
  ) {
    throw new ExecutionError(
      "not_ready",
      "The allocation's current private inventory or signed valuation is unavailable.",
    );
  }
  const valuation = priced.value;
  await userTransaction(db, userId, async (tx) => {
    if (await repeatedFunding(tx, userId, input)) {
      return;
    }
    const agent = await ownedAgent(tx, userId, preview.agentId);
    const now = await databaseTime(tx);
    if (
      agent.status === "running" ||
      agent.revision !== preview.agentRevision ||
      agent.version !== preview.strategyVersion ||
      now >= valuation.expiresAt
    ) {
      throw new ExecutionError(
        "conflict",
        "The preview expired or the agent changed. Pause and review a fresh allocation.",
      );
    }
    await setUserCapitalLimit(tx, userId, {
      requestId: requestPart(input.requestId, "shared"),
      amountMicroUsd: parseUsd(input.sharedCapitalUsd).toString(),
    });
    await setAgentCapitalLimit(tx, userId, {
      requestId: requestPart(input.requestId, "agent"),
      agentId: agent.id,
      amountMicroUsd: parseUsd(input.agentCapitalUsd).toString(),
    });
    await assignInventory(tx, userId, {
      requestId: requestPart(input.requestId, "inventory"),
      agentId: agent.id,
      scope: "confidential",
      assetId: quote.inputAssetId,
      quantityUnits: quote.inputUnits,
      capitalMicroUsd: valuation.inputMicroUsd,
      costBasisMicroUsd: null,
      sourceReference: `preview:${preview.id}`,
      evidenceHash: valuation.quoteHash,
    });
    await tx.insert(agentEvents).values({
      id: input.requestId,
      userId,
      agentId: agent.id,
      kind: "capital_reviewed",
      message: "Allocated the reviewed private-balance units and capital limits. No funds were transferred.",
      detailJson: JSON.stringify({ inputHash: executionHash(input) }),
      createdAt: now,
    });
  });
}
