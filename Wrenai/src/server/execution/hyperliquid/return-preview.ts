import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { tradePreviews } from "@/server/db/preview-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { policySchema } from "@/shared/agents";
import { type PerpsReturnPreview, perpsReturnInputSchema } from "@/shared/perps-return";
import { minimumUnits } from "@/shared/token-units";
import { currentAgentStrategy, registryTradeAsset, resolvedTradeAssets } from "../asset-review";
import { privateBalanceToken } from "../balance-session";
import { ExecutionError } from "../contracts";
import { oneClickJson } from "../oneclick-quote";
import { databaseTime, executionHash } from "../records";
import { hlAddressSchema, perpsCashAssetId } from "./contracts";
import { hlUnits } from "./decimal";
import {
  type PerpsReturnRecord,
  returnQuoteRequest,
  returnRecordSchema,
  verifiedReturnQuote,
} from "./return-record";
import { ownedReturnSource, requireClosedReturnVenue } from "./return-source";

export function savedReturnPreview(row: typeof tradePreviews.$inferSelect): PerpsReturnRecord {
  const saved = returnRecordSchema.parse(JSON.parse(row.snapshotJson));
  if (
    row.evidenceHash !== executionHash(saved) ||
    row.agentId !== saved.agentId ||
    row.requestId !== saved.requestId ||
    row.agentRevision !== saved.agentRevision ||
    row.strategyVersion !== saved.strategyVersion ||
    row.createdAt !== saved.quotedAt ||
    row.expiresAt !== saved.expiresAt
  ) {
    throw new ExecutionError(
      "conflict",
      "The saved return preview is inconsistent. Request a fresh preview.",
    );
  }
  return saved;
}
function displayPreview(row: typeof tradePreviews.$inferSelect): PerpsReturnPreview {
  const saved = savedReturnPreview(row),
    quote = verifiedReturnQuote(saved, saved.quotedAt);
  return {
    id: row.id,
    agentId: saved.agentId,
    evidenceHash: row.evidenceHash,
    expiresAt: saved.expiresAt,
    debitUnits: saved.debitUnits,
    networkFeeUnits: "1000000",
    receiveUnits: quote.minOutputUnits,
    quotedReceiveUnits: quote.outputUnits,
    receiveSymbol: saved.output.tokenSymbol,
    receiveDecimals: saved.output.decimals,
    destinationAccount: saved.ownerAccountId,
  };
}
export async function createPerpsReturnPreview(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<PerpsReturnPreview> {
  const input = perpsReturnInputSchema.parse(raw);
  await ownedReturnSource(db, user.id, input.agentId);
  const [existing] = await db
    .select()
    .from(tradePreviews)
    .where(and(eq(tradePreviews.userId, user.id), eq(tradePreviews.requestId, input.requestId)))
    .limit(1);
  if (existing) {
    if (existing.requestHash !== executionHash(input)) {
      throw new ExecutionError("conflict", "This request already belongs to another preview.");
    }
    return displayPreview(existing);
  }
  const [registry, venue, session] = await Promise.all([
    intentTokens(),
    requireClosedReturnVenue(db, user.id, input.agentId),
    privateBalanceToken(db, user.id),
  ]);
  if (!session) {
    throw new ExecutionError("not_ready", "Connect your private balance before returning funds.");
  }
  const current = await currentAgentStrategy(db, user.id, input.agentId, input.expectedRevision),
    { account } = await ownedReturnSource(db, user.id, input.agentId);
  if (current.strategy.kind !== "perps") {
    throw new ExecutionError("not_ready", "Only a reviewed Perps strategy can return venue funds.");
  }
  const collateralAssetId = current.strategy.collateralAssetId;
  const assets = resolvedTradeAssets(current.strategy, current.version.resolvedAssetsJson, registry.tokens),
    output = assets.find((asset) => asset.assetId === collateralAssetId);
  if (!output?.assetId.startsWith("nep141:")) {
    throw new ExecutionError(
      "not_ready",
      "Review the exact private collateral token before returning funds.",
    );
  }
  // The returned token is the owner's reviewed collateral, never an arbitrary model-supplied destination.
  const matches = registry.tokens.filter((token) => token.assetId === output.assetId),
    token = matches[0];
  if (matches.length !== 1 || !token || executionHash(registryTradeAsset(token)) !== executionHash(output)) {
    throw new ExecutionError("not_ready", "The reviewed return token changed.");
  }
  const owned = await unreservedOwnedUnits(
    db,
    user.id,
    input.agentId,
    "hyperliquid",
    perpsCashAssetId(account.perpAddress),
  );
  const beforeCashUnits = hlUnits(venue.crossMarginSummary.totalRawUsd, 6, "down"),
    debit = minimumUnits(owned, minimumUnits(beforeCashUnits, hlUnits(venue.withdrawable, 6, "down")));
  if (debit < 1_500_000n) {
    throw new ExecutionError(
      "insufficient_funds",
      "At least 1.5 USDC of owned, withdrawable funds is needed for this route and its transfer fee.",
    );
  }
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  // usdSend deducts another 1 USDC; the 0.2 USDC bridge deposit cost is already inside the quote.
  // https://docs.near-intents.org/integration/distribution-channels/1click-api/hyperliquid
  const request = {
    bridgeUnits: ((debit - 1_000_000n) * 100n).toString(),
    output,
    address: account.perpAddress,
    ownerAccountId: user.accountId,
    requestDeadline: new Date(Date.now() + 120_000).toISOString(),
    slippageBps: Math.max(1, policy.maxSlippageBps),
  };
  if (policy.maxSlippageBps < 1) {
    throw new ExecutionError("not_ready", "Set a nonzero slippage cap before requesting this return route.");
  }
  const providerQuote = await oneClickJson("/v0/quote", returnQuoteRequest(request), undefined, session);
  const provider = z
    .object({
      timestamp: z.iso.datetime(),
      quote: z.object({ depositAddress: hlAddressSchema, deadline: z.iso.datetime() }),
    })
    .parse(providerQuote);
  const quotedAt = Date.now();
  const saved = returnRecordSchema.parse({
    format: "perps-return-v1",
    ...request,
    requestId: input.requestId,
    agentId: input.agentId,
    agentRevision: current.agent.revision,
    strategyVersion: current.agent.version,
    rootId: account.rootId,
    debitUnits: debit.toString(),
    beforeCashUnits: beforeCashUnits.toString(),
    quotedAt,
    expiresAt: Math.min(quotedAt + 15_000, Date.parse(provider.timestamp) + 15_000),
    maximumProviderFeeBps: policy.maxProviderFeeBps,
    depositAddress: provider.quote.depositAddress,
    providerDeadline: provider.quote.deadline,
    providerQuote,
  });
  verifiedReturnQuote(saved, quotedAt);
  return userTransaction(db, user.id, async (tx) => {
    const { agent, account: fresh } = await ownedReturnSource(tx, user.id, input.agentId);
    if (
      agent.revision !== saved.agentRevision ||
      fresh.rootId !== saved.rootId ||
      fresh.perpAddress !== saved.address ||
      saved.expiresAt <= (await databaseTime(tx))
    ) {
      throw new ExecutionError("conflict", "The return account or preview changed. Request a fresh preview.");
    }
    const [row] = await tx
      .insert(tradePreviews)
      .values({
        id: randomUUID(),
        userId: user.id,
        agentId: input.agentId,
        requestId: input.requestId,
        requestHash: executionHash(input),
        evidenceHash: executionHash(saved),
        agentRevision: saved.agentRevision,
        strategyVersion: saved.strategyVersion,
        riskPolicyRevision: 0,
        snapshotJson: JSON.stringify(saved),
        createdAt: saved.quotedAt,
        expiresAt: saved.expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    const stored =
      row ??
      (
        await tx
          .select()
          .from(tradePreviews)
          .where(and(eq(tradePreviews.userId, user.id), eq(tradePreviews.requestId, input.requestId)))
          .limit(1)
      )[0];
    if (!stored || stored.requestHash !== executionHash(input)) {
      throw new ExecutionError("conflict", "This preview request already binds different amounts.");
    }
    return displayPreview(stored);
  });
}
