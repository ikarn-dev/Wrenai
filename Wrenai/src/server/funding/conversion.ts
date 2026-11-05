import "server-only";
import { randomUUID } from "node:crypto";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { delegatedKeys } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { reserveDefiExecution } from "@/server/execution/defi-reservations";
import { preparedOrderSchema } from "@/server/execution/intents-order";
import { prepareIntentsOrder } from "@/server/execution/intents-quote";
import { dryQuoteRequest, verifiedProviderQuote } from "@/server/execution/oneclick-quote";
import { confirmExecutionPermission } from "@/server/execution/permissions";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
} from "@/server/execution/records";
import { policySchema } from "@/shared/agents";
import { synchronizePublicToken } from "./public-inventory";
import { ownedWalletFunding, walletFundingView } from "./records";

export const walletConversionRecordSchema = z.strictObject({
  format: z.literal(1),
  fundingId: z.uuid(),
  order: preparedOrderSchema,
});
export async function walletConversionRecord(
  db: AppDatabase,
  action: LedgerAction,
): Promise<z.infer<typeof walletConversionRecordSchema>> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "wallet_conversion_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The funding quote record is missing or duplicated.");
  }
  return walletConversionRecordSchema.parse(JSON.parse(rows[0].detailJson));
}
export function verifiedWalletQuote(
  action: LedgerAction,
  saved: z.infer<typeof walletConversionRecordSchema>,
  accountId: string,
  now: number,
): ReturnType<typeof verifiedProviderQuote> {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    source = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    destination = plan.cash.find((cash) => cash.scope === "confidential");
  if (
    !source ||
    !destination ||
    plan.walletFundingId !== saved.fundingId ||
    plan.payloadHash !== saved.order.payloadHash ||
    plan.quoteId !== saved.order.depositAddress ||
    plan.recipient !== accountId
  ) {
    throw new ExecutionError("conflict", "The public-to-private funding quote changed.");
  }
  const request = {
    ...dryQuoteRequest(
      accountId,
      source.assetId,
      destination.assetId,
      source.maxDebitUnits,
      plan.slippageBps,
      "intents",
      saved.order.quotedAt,
    ),
    dry: false,
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
    deadline: saved.order.requestDeadline,
  };
  const quote = verifiedProviderQuote(saved.order.providerQuote, request, "intents", now, plan.slippageBps);
  if (
    quote.quoteHash !== plan.quoteHash ||
    quote.minOutputUnits !== destination.minCreditUnits ||
    quote.appFeeBps > saved.order.maximumProviderFeeBps ||
    BigInt(quote.inputMicroUsd ?? "0") > action.notionalMicroUsd
  ) {
    throw new ExecutionError("limit", "The funding quote changed its input, credit or cost.");
  }
  return quote;
}

export async function prepareWalletConversion(
  db: AppDatabase,
  user: SessionUser,
  fundingId: string,
): Promise<LedgerAction> {
  const row = await ownedWalletFunding(db, user.id, fundingId),
    snapshot = walletFundingView(row).snapshot;
  if (row.actionId) {
    const existing = await ownedLedgerAction(db, user.id, row.actionId);
    if (existing.status !== "cancelled" && existing.status !== "settled") {
      return existing;
    }
    if (existing.reservationReleasedAt === null) {
      throw new ExecutionError("not_ready", "Wait for the previous funding outcome to reconcile.");
    }
  }
  if (row.state !== "deposited" || !row.transactionHash) {
    throw new ExecutionError("not_ready", "Confirm the wallet deposit before preparing private funding.");
  }
  const agent = await ownedAgent(db, user.id, row.agentId),
    policy = policySchema.parse(JSON.parse(agent.policyJson));
  if (agent.status === "running" || agent.version !== row.strategyVersion) {
    throw new ExecutionError("conflict", "The agent changed before private funding.");
  }
  await synchronizePublicToken(db, user.id, user.accountId, snapshot.assetId);
  await synchronizePrivateInventory(db, user.id);
  const order = await prepareIntentsOrder({
    accountId: user.accountId,
    inputAssetId: snapshot.assetId,
    outputAssetId: snapshot.assetId,
    inputUnits: snapshot.units,
    walletShield: true,
    slippageBps: Math.min(policy.maxSlippageBps, snapshot.maximumSlippageBps),
    maximumProviderFeeBps: Math.min(policy.maxProviderFeeBps, snapshot.maximumProviderFeeBps),
  });
  if (BigInt(order.quote.minOutputUnits) < BigInt(snapshot.minimumPrivateUnits)) {
    throw new ExecutionError(
      "limit",
      "Funding fees moved beyond your review. No new transfer was signed. Retry when costs improve or release the public funds.",
    );
  }
  const envelope = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  return userTransaction(db, user.id, async (tx) => {
    const latest = await ownedWalletFunding(tx, user.id, fundingId),
      now = await databaseTime(tx);
    if (latest.actionId !== row.actionId || latest.state !== "deposited") {
      if (latest.actionId) {
        return ownedLedgerAction(tx, user.id, latest.actionId);
      }
      throw new ExecutionError("conflict", "The funding state changed.");
    }
    const [key] = await tx.select().from(delegatedKeys).where(eq(delegatedKeys.userId, user.id)).limit(1);
    if (!key?.activatedAt || !key.activatedAtBlock) {
      throw new ExecutionError("not_ready", "Verify the shared app authorization before funding.");
    }
    const permissionHash = await confirmExecutionPermission(tx, user.id, {
      agentId: agent.id,
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      scope: "intents",
      venueId: "near-intents",
      signingPublicKey: key.publicKey,
      operations: ["transfer"],
      assetIds: [snapshot.assetId],
      instruments: [],
      recipients: [user.accountId],
      expiresAt: null,
    });
    const requestId = randomUUID();
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId,
      agentId: agent.id,
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      funding: true,
      walletFundingId: row.id,
      scope: "intents",
      operation: "transfer",
      venueId: "near-intents",
      permissionHash,
      cash: [
        { scope: "intents", assetId: snapshot.assetId, maxDebitUnits: snapshot.units, minCreditUnits: "0" },
        {
          scope: "confidential",
          assetId: snapshot.assetId,
          maxDebitUnits: "0",
          minCreditUnits: order.quote.minOutputUnits,
        },
      ],
      positions: [],
      notionalMicroUsd: order.quote.inputMicroUsd,
      slippageBps: order.quote.slippageBps,
      providerFeeBps: order.quote.appFeeBps,
      quoteId: order.depositAddress,
      quoteHash: order.quote.quoteHash,
      payloadHash: order.payloadHash,
      recipient: user.accountId,
      expiresAt: order.quote.expiresAt,
    });
    const action = await reserveDefiExecution(tx, user.id, plan);
    const saved = walletConversionRecordSchema.parse({
      format: 1,
      fundingId,
      order: {
        format: 1,
        signalHash: executionHash({ fundingId, transactionHash: row.transactionHash }),
        quotedAt: order.quote.capturedAt,
        maximumProviderFeeBps: Math.min(policy.maxProviderFeeBps, snapshot.maximumProviderFeeBps),
        requestDeadline: envelope.quoteRequest.deadline,
        providerDeadline: envelope.quote.deadline,
        providerQuote: order.providerQuote,
        generated: order.generated,
        payloadHash: order.payloadHash,
        depositAddress: order.depositAddress,
      },
    });
    verifiedWalletQuote(action, saved, user.accountId, now);
    await executionEvent(tx, action, "wallet_conversion_prepared", now, saved);
    await tx
      .update(walletFundings)
      .set({ actionId: action.id, state: "converting", updatedAt: now })
      .where(eq(walletFundings.id, row.id));
    return action;
  });
}
