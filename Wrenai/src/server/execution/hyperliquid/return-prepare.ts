import "server-only";
import { and, eq } from "drizzle-orm";
import { auditAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { tradePreviews } from "@/server/db/preview-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { perpsReturnConfirmationSchema } from "@/shared/perps-return";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { reserveDefiExecution } from "../defi-reservations";
import { confirmExecutionPermission } from "../permissions";
import { synchronizePrivateInventory } from "../private-inventory";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "../records";
import { perpsCashAssetId } from "./contracts";
import { hlUnits } from "./decimal";
import { perpsAuthority } from "./journal";
import { savedReturnPreview } from "./return-preview";
import { returnTransferTemplate, validateReturnPlan, verifiedReturnQuote } from "./return-record";
import { ownedReturnSource, requireClosedReturnVenue } from "./return-source";

export async function preparePerpsReturn(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<LedgerAction> {
  const input = perpsReturnConfirmationSchema.parse(raw);
  const [preview] = await db
    .select()
    .from(tradePreviews)
    .where(and(eq(tradePreviews.userId, user.id), eq(tradePreviews.id, input.previewId)))
    .limit(1);
  if (!preview || preview.evidenceHash !== input.evidenceHash) {
    throw new ExecutionError("not_found", "Return preview not found. Request a fresh preview.");
  }
  const saved = savedReturnPreview(preview);
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, user.id), eq(executionActions.requestId, saved.requestId)))
    .limit(1);
  if (existing) {
    validateReturnPlan(defiPlanSchema.parse(JSON.parse(existing.planJson)), saved, saved.quotedAt);
    return existing;
  }
  await ownedReturnSource(db, user.id, saved.agentId);
  const [venue, authority] = await Promise.all([
    requireClosedReturnVenue(db, user.id, saved.agentId),
    perpsAuthority(db, user.id, saved.agentId),
    synchronizePrivateInventory(db, user.id),
  ]);
  if (
    hlUnits(venue.crossMarginSummary.totalRawUsd, 6, "down") !== BigInt(saved.beforeCashUnits) ||
    hlUnits(venue.withdrawable, 6, "down") < BigInt(saved.debitUnits) ||
    authority.wallet.address !== saved.address
  ) {
    throw new ExecutionError("conflict", "Venue funds changed. Request a fresh fee preview.");
  }
  return userTransaction(db, user.id, async (tx) => {
    const duplicate = (
      await tx
        .select()
        .from(executionActions)
        .where(and(eq(executionActions.userId, user.id), eq(executionActions.requestId, saved.requestId)))
        .limit(1)
    )[0];
    if (duplicate) {
      validateReturnPlan(defiPlanSchema.parse(JSON.parse(duplicate.planJson)), saved, saved.quotedAt);
      return duplicate;
    }
    const { agent, account } = await ownedReturnSource(tx, user.id, saved.agentId),
      now = await databaseTime(tx);
    const quote = verifiedReturnQuote(saved, now);
    if (
      agent.revision !== saved.agentRevision ||
      agent.version !== saved.strategyVersion ||
      account.rootId !== saved.rootId ||
      account.perpAddress !== saved.address ||
      saved.ownerAccountId !== user.accountId
    ) {
      throw new ExecutionError(
        "conflict",
        "The return account or strategy changed. Request a fresh preview.",
      );
    }
    const source = perpsCashAssetId(saved.address);
    const permissionHash = await confirmExecutionPermission(tx, user.id, {
      agentId: saved.agentId,
      agentRevision: saved.agentRevision,
      strategyVersion: saved.strategyVersion,
      scope: "hyperliquid",
      venueId: "hyperliquid",
      signingPublicKey: authority.sharedPublicKey,
      operations: ["transfer"],
      assetIds: [source, saved.output.assetId],
      instruments: [],
      recipients: [user.accountId],
      expiresAt: saved.expiresAt,
    });
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId: saved.requestId,
      agentId: saved.agentId,
      agentRevision: saved.agentRevision,
      strategyVersion: saved.strategyVersion,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      funding: true,
      returnFunds: true,
      fundingFeeUnits: "1000000",
      scope: "hyperliquid",
      operation: "transfer",
      venueId: "hyperliquid",
      permissionHash,
      cash: [
        { assetId: source, maxDebitUnits: saved.debitUnits, minCreditUnits: "0" },
        {
          assetId: saved.output.assetId,
          scope: "confidential",
          maxDebitUnits: "0",
          minCreditUnits: quote.minOutputUnits,
        },
      ],
      positions: [],
      notionalMicroUsd: saved.debitUnits,
      slippageBps: saved.slippageBps,
      providerFeeBps: quote.appFeeBps,
      quoteId: saved.depositAddress,
      quoteHash: quote.quoteHash,
      payloadHash: executionHash(returnTransferTemplate(saved)),
      recipient: user.accountId,
      expiresAt: saved.expiresAt,
    });
    validateReturnPlan(plan, saved, now);
    await auditAgent(
      tx,
      user.id,
      saved.agentId,
      "perps_return_confirmed",
      "Confirmed the return of closed Perps funds to the private balance.",
      { previewId: preview.id, evidenceHash: preview.evidenceHash, planHash: executionHash(plan) },
    );
    const action = await reserveDefiExecution(tx, user.id, plan);
    await executionEvent(tx, action, "perps_return_prepared", now, saved);
    return action;
  });
}
