import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { ensureAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { policySchema } from "@/shared/agents";
import { currentAgentStrategy } from "./asset-review";
import { privateBalanceToken } from "./balance-session";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { reserveDefiExecution } from "./defi-reservations";
import { verifiedAccountFunding } from "./funding-policy";
import { synchronizePerpsInventory } from "./hyperliquid/account-state";
import { HYPERLIQUID_BRIDGE_USDC, perpsCashAssetId } from "./hyperliquid/contracts";
import { preparedOrderSchema } from "./intents-order";
import { prepareIntentsOrder } from "./intents-quote";
import { dryQuoteRequest, verifiedProviderQuote } from "./oneclick-quote";
import { confirmExecutionPermission } from "./permissions";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "./records";

const fundingRecordSchema = z.strictObject({
  format: z.literal(1),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  order: preparedOrderSchema,
});
export type PerpsFundingRecord = z.infer<typeof fundingRecordSchema>;
export async function perpsFundingRecord(db: AppDatabase, action: LedgerAction): Promise<PerpsFundingRecord> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "perps_funding_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The venue deposit has no unique immutable quote record.");
  }
  return fundingRecordSchema.parse(JSON.parse(rows[0].detailJson));
}
export function verifiedFundingQuote(
  action: LedgerAction,
  saved: PerpsFundingRecord,
  accountId: string,
  now: number,
): ReturnType<typeof verifiedProviderQuote> {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    source = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    destination = plan.cash.find((cash) => cash.scope === "hyperliquid");
  if (
    !plan.funding ||
    !source ||
    !destination ||
    plan.recipient !== saved.recipient ||
    destination.assetId !== perpsCashAssetId(saved.recipient) ||
    saved.order.payloadHash !== plan.payloadHash ||
    saved.order.depositAddress !== plan.quoteId
  ) {
    throw new ExecutionError(
      "conflict",
      "The venue deposit differs from its reserved source or destination.",
    );
  }
  const request = {
    ...dryQuoteRequest(
      accountId,
      source.assetId,
      HYPERLIQUID_BRIDGE_USDC,
      source.maxDebitUnits,
      Math.max(0, plan.slippageBps - 1),
      "confidential",
      saved.order.quotedAt,
    ),
    dry: false,
    recipient: saved.recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline: saved.order.requestDeadline,
  };
  const quote = verifiedProviderQuote(
    saved.order.providerQuote,
    request,
    "confidential",
    now,
    plan.slippageBps,
  );
  const minimumValue =
    (BigInt(quote.outputMicroUsd ?? "0") * BigInt(quote.minOutputUnits)) / BigInt(quote.outputUnits);
  const maximumCostBps = plan.slippageBps + saved.order.maximumProviderFeeBps;
  // The bridge asset uses 8 decimals; only complete 6-decimal venue cash units can be reserved.
  if (
    quote.quoteHash !== plan.quoteHash ||
    quote.inputUnits !== source.maxDebitUnits ||
    BigInt(quote.minOutputUnits) / 100n !== BigInt(destination.minCreditUnits) ||
    quote.appFeeBps > plan.providerFeeBps ||
    BigInt(quote.inputMicroUsd ?? "0") > action.notionalMicroUsd ||
    BigInt(destination.minCreditUnits) <= 0n ||
    minimumValue * 10000n < BigInt(quote.inputMicroUsd ?? "0") * BigInt(10000 - maximumCostBps)
  ) {
    throw new ExecutionError(
      "limit",
      "The signed bridge quote changes its debit, minimum credit, valuation or fees.",
    );
  }
  return quote;
}

/** Called by the reviewed Perps lifecycle, after exact private-token allocation, never by model free text. */
export async function preparePerpsFunding(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
  requestId: string,
): Promise<LedgerAction> {
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  if (existing) {
    if (existing.agentId !== agentId || !defiPlanSchema.parse(JSON.parse(existing.planJson)).funding) {
      throw new ExecutionError("conflict", "This request belongs to a different action.");
    }
    await perpsFundingRecord(db, existing);
    return existing;
  }
  const current = await currentAgentStrategy(db, userId, agentId, revision),
    instruction = current.strategy;
  if (instruction.kind !== "perps" || current.agent.status !== "running") {
    throw new ExecutionError("not_ready", "A running, reviewed Perps instruction is required for funding.");
  }
  const account = await ensureAgentTradingAccount(db, userId, agentId);
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const session = await privateBalanceToken(db, userId);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect the private balance before venue funding.");
  }
  await synchronizePrivateInventory(db, userId);
  const state = await synchronizePerpsInventory(db, userId, agentId);
  if (state.assetPositions.some((p) => /[1-9]/.test(p.position.szi))) {
    throw new ExecutionError("conflict", "A new funding cycle cannot replace an existing venue position.");
  }
  const units = await unreservedOwnedUnits(
    db,
    userId,
    agentId,
    "confidential",
    instruction.collateralAssetId,
  );
  if (units <= 0n) {
    throw new ExecutionError(
      "insufficient_funds",
      "Allocate this agent's selected private tokens before venue funding.",
    );
  }
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const order = await prepareIntentsOrder(
    {
      accountId: owner.accountId,
      inputAssetId: instruction.collateralAssetId,
      outputAssetId: HYPERLIQUID_BRIDGE_USDC,
      inputUnits: units.toString(),
      perpsRecipient: account.perpAddress,
      slippageBps: policy.maxSlippageBps,
      maximumProviderFeeBps: policy.maxProviderFeeBps,
    },
    undefined,
    session,
  );
  const envelope = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  return userTransaction(db, userId, async (tx) => {
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.agentId, agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (pending) {
      throw new ExecutionError("conflict", "Reconcile the previous action before funding this agent.");
    }
    const [key] = await tx.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
    if (!key?.activatedAt || !key.activatedAtBlock) {
      throw new ExecutionError("not_ready", "Verify the shared app authorization before funding.");
    }
    const cashAsset = perpsCashAssetId(account.perpAddress);
    const permissionHash = await confirmExecutionPermission(tx, userId, {
      agentId,
      agentRevision: revision,
      strategyVersion: current.agent.version,
      scope: "confidential",
      venueId: "confidential-intents",
      signingPublicKey: key.publicKey,
      operations: ["transfer"],
      assetIds: [instruction.collateralAssetId, cashAsset],
      instruments: [],
      recipients: [account.perpAddress],
      expiresAt: null,
    });
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId,
      agentId,
      agentRevision: revision,
      strategyVersion: current.agent.version,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      funding: true,
      scope: "confidential",
      operation: "transfer",
      venueId: "confidential-intents",
      permissionHash,
      cash: [
        {
          assetId: instruction.collateralAssetId,
          maxDebitUnits: order.quote.inputUnits,
          minCreditUnits: "0",
        },
        {
          scope: "hyperliquid",
          assetId: cashAsset,
          maxDebitUnits: "0",
          minCreditUnits: (BigInt(order.quote.minOutputUnits) / 100n).toString(),
        },
      ],
      positions: [],
      notionalMicroUsd: order.quote.inputMicroUsd,
      slippageBps: policy.maxSlippageBps,
      providerFeeBps: order.quote.appFeeBps,
      quoteId: order.depositAddress,
      quoteHash: order.quote.quoteHash,
      payloadHash: order.payloadHash,
      recipient: account.perpAddress,
      expiresAt: order.quote.expiresAt,
    });
    await verifiedAccountFunding(tx, userId, plan);
    const action = await reserveDefiExecution(tx, userId, plan);
    const saved = fundingRecordSchema.parse({
      format: 1,
      recipient: account.perpAddress,
      order: {
        format: 1,
        signalHash: executionHash({
          requestId,
          assetId: instruction.collateralAssetId,
          units: units.toString(),
          recipient: account.perpAddress,
        }),
        quotedAt: order.quote.capturedAt,
        maximumProviderFeeBps: policy.maxProviderFeeBps,
        requestDeadline: envelope.quoteRequest.deadline,
        providerDeadline: envelope.quote.deadline,
        providerQuote: order.providerQuote,
        generated: order.generated,
        payloadHash: order.payloadHash,
        depositAddress: order.depositAddress,
      },
    });
    verifiedFundingQuote(action, saved, owner.accountId, Date.now());
    await executionEvent(tx, action, "perps_funding_prepared", await databaseTime(tx), saved);
    return action;
  });
}
