import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { synchronizePublicToken } from "@/server/funding/public-inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { policySchema } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import { privateBalanceToken } from "./balance-session";
import { ExecutionError } from "./contracts";
import { defiPlanSchema, WALLET_RETURN_VENUES } from "./defi-contracts";
import { reserveDefiExecution } from "./defi-reservations";
import {
  generatedIntentSchema,
  MAX_PROVIDER_INTENT_VALIDITY_MS,
  validateGeneratedIntent,
} from "./intents-payload";
import { preparedOrderSchema } from "./intents-record";
import { dryQuoteRequest, oneClickJson, verifiedProviderQuote } from "./oneclick-quote";
import { confirmExecutionPermission } from "./permissions";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "./records";

export type IntentsReturnScope = "confidential" | "intents";

export const walletReturnRecordSchema = z.strictObject({
  format: z.literal(1),
  amountUnits: z.string().regex(/^[1-9]\d{0,77}$/),
  recipient: z.string().min(2).max(64),
  // Absent on returns made as held (every record before Nov 5, 2026).
  payoutAssetId: z.string().min(3).max(180).optional(),
  order: preparedOrderSchema,
});
export type WalletReturnRecord = z.infer<typeof walletReturnRecordSchema>;

/** The exact 1Click request that moves one balance to the owner's NEAR wallet, as held or swapped to `payout`. */
function returnQuoteRequest(
  accountId: string,
  scope: IntentsReturnScope,
  assetId: string,
  payoutAssetId: string,
  units: string,
  slippageBps: number,
  quotedAt: number,
  deadline?: string,
): QuoteRequest {
  const request = dryQuoteRequest(accountId, assetId, payoutAssetId, units, slippageBps, scope, quotedAt);
  return {
    ...request,
    dry: false,
    recipient: accountId,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    ...(deadline ? { deadline } : {}),
  };
}

export async function walletReturnRecord(db: AppDatabase, action: LedgerAction): Promise<WalletReturnRecord> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "wallet_return_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The return has no unique preparation record.");
  }
  return walletReturnRecordSchema.parse(JSON.parse(rows[0].detailJson));
}

/** Time left before 1Click's request deadline that a return still needs to be sent (deposit and settle). */
const SUBMIT_MARGIN_MS = 30_000;
/**
 * A return swapped into another token has a price that can go stale, so it is sent within this time of its quote.
 * Longer than the 15 s trade window, which prepare, reserve and claim regularly exceeded (Docs/LESSONS.md).
 */
const SWAPPED_RETURN_MAX_AGE_MS = 45_000;

/**
 * Re-verifies a stored return quote. The signature, amounts and fee limits are checked against the quote as
 * captured. It is not re-aged with the 15 s price-freshness rule: a return moves the same token in and out, so no
 * price can go stale, and preparing, reserving and claiming regularly took longer than 15 s, so every return was
 * cancelled before sending (Nov 2026). What binds a return is 1Click's request deadline: `submitAt` must leave
 * SUBMIT_MARGIN_MS before it. Reconciliation passes null, since a sent return is checked after the deadline.
 */
export function verifiedWalletReturnQuote(
  action: LedgerAction,
  saved: WalletReturnRecord,
  accountId: string,
  submitAt: number | null,
): TradeQuote {
  if (submitAt !== null && submitAt > Date.parse(saved.order.requestDeadline) - SUBMIT_MARGIN_MS) {
    throw new ExecutionError(
      "not_ready",
      "The return quote expired before it was sent. A new one is requested.",
    );
  }
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    cash = plan.cash[0];
  const payout = plan.payoutAssetId ?? cash?.assetId;
  if (
    plan.payoutAssetId !== undefined &&
    submitAt !== null &&
    submitAt > saved.order.quotedAt + SWAPPED_RETURN_MAX_AGE_MS
  ) {
    throw new ExecutionError("not_ready", "The return quote is too old to send. A new one is requested.");
  }
  if (
    !plan.walletReturn ||
    (plan.scope !== "confidential" && plan.scope !== "intents") ||
    !cash ||
    payout === undefined ||
    (saved.payoutAssetId ?? cash.assetId) !== payout ||
    saved.recipient !== accountId ||
    plan.recipient !== accountId ||
    saved.amountUnits !== cash.maxDebitUnits ||
    saved.order.payloadHash !== plan.payloadHash ||
    saved.order.depositAddress !== plan.quoteId
  ) {
    throw new ExecutionError("conflict", "The return differs from its reviewed owner, amount or payload.");
  }
  const request = returnQuoteRequest(
    accountId,
    plan.scope,
    cash.assetId,
    payout,
    saved.amountUnits,
    plan.slippageBps,
    saved.order.quotedAt,
    saved.order.requestDeadline,
  );
  const quote = verifiedProviderQuote(
    saved.order.providerQuote,
    request,
    plan.scope,
    saved.order.quotedAt,
    plan.slippageBps,
  );
  const cost = BigInt(quote.inputUnits) - BigInt(quote.minOutputUnits);
  if (
    quote.quoteHash !== plan.quoteHash ||
    quote.inputUnits !== cash.maxDebitUnits ||
    quote.appFeeBps > plan.providerFeeBps ||
    quote.appFeeBps > saved.order.maximumProviderFeeBps ||
    BigInt(quote.minOutputUnits) <= 0n ||
    // Same token in and out: the whole difference is route cost, held to the fee and slippage limits. A swapped
    // payout is held to the same limits through the provider fee cap and the signed minimum output.
    (payout === cash.assetId &&
      (cost < 0n ||
        cost * 10_000n >
          BigInt(quote.inputUnits) * BigInt(saved.order.maximumProviderFeeBps + plan.slippageBps)))
  ) {
    throw new ExecutionError(
      "limit",
      "Returning this token costs more than the agent's fee and slippage limits allow.",
    );
  }
  return quote;
}

/**
 * Quotes one move to the owner's NEAR wallet and prepares its signing payload. No database writes. A return as held
 * stays valid until SUBMIT_MARGIN_MS before 1Click's deadlines: the same token goes in and out, so no price can go
 * stale. A swapped payout is also bounded by SWAPPED_RETURN_MAX_AGE_MS from its quote.
 */
export async function quoteWalletReturn(input: {
  readonly accountId: string;
  readonly scope: IntentsReturnScope;
  readonly assetId: string;
  /** The token paid to the wallet; the held token itself for a return as held. */
  readonly payoutAssetId: string;
  readonly units: bigint;
  readonly slippageBps: number;
  readonly maximumProviderFeeBps: number;
  readonly requestId: string;
  readonly session: string | undefined;
}): Promise<{ readonly quote: TradeQuote; readonly saved: WalletReturnRecord; readonly expiresAt: number }> {
  const { accountId, scope, assetId, payoutAssetId } = input;
  const swapped = payoutAssetId !== assetId;
  const request = returnQuoteRequest(
    accountId,
    scope,
    assetId,
    payoutAssetId,
    input.units.toString(),
    input.slippageBps,
    Date.now(),
  );
  const providerQuote = await oneClickJson("/v0/quote", request, undefined, input.session);
  const quote = verifiedProviderQuote(providerQuote, request, scope, Date.now(), input.slippageBps);
  const envelope = z
    .object({
      quote: z.object({
        depositAddress: z.string().regex(/^[a-f0-9]{64}$/),
        depositMemo: z.never().optional(),
        deadline: z.iso.datetime(),
      }),
    })
    .parse(providerQuote).quote;
  const generated = validateGeneratedIntent(
    generatedIntentSchema.parse(
      await oneClickJson("/v0/generate-intent", {
        type: "swap_transfer",
        standard: "nep413",
        signerId: accountId,
        depositAddress: envelope.depositAddress,
      }),
    ),
    {
      signerId: accountId,
      scope,
      depositAddress: envelope.depositAddress,
      inputAssetId: assetId,
      inputUnits: quote.inputUnits,
      providerDeadline: envelope.deadline,
      maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
      now: Date.now(),
    },
  );
  if (quote.appFeeBps > input.maximumProviderFeeBps) {
    throw new ExecutionError(
      "limit",
      `Blocked: the provider fee is ${quote.appFeeBps / 100}%, over the ${input.maximumProviderFeeBps / 100}% limit.`,
    );
  }
  const expiresAt = Math.min(
    Date.parse(request.deadline) - SUBMIT_MARGIN_MS,
    Date.parse(envelope.deadline) - SUBMIT_MARGIN_MS,
    swapped ? quote.capturedAt + SWAPPED_RETURN_MAX_AGE_MS : Number.POSITIVE_INFINITY,
  );
  if (expiresAt <= Date.now()) {
    throw new ExecutionError("not_ready", "The return quote expired at once. Try again.");
  }
  const saved = walletReturnRecordSchema.parse({
    format: 1,
    amountUnits: quote.inputUnits,
    recipient: accountId,
    ...(swapped ? { payoutAssetId } : {}),
    order: {
      format: 1,
      signalHash: executionHash({
        requestId: input.requestId,
        assetId,
        scope,
        units: quote.inputUnits,
        ...(swapped ? { payoutAssetId } : {}),
      }),
      quotedAt: quote.capturedAt,
      maximumProviderFeeBps: input.maximumProviderFeeBps,
      requestDeadline: request.deadline,
      providerDeadline: envelope.deadline,
      providerQuote,
      generated: generated.intent,
      payloadHash: generated.payloadHash,
      depositAddress: envelope.depositAddress,
    },
  });
  return { quote, saved, expiresAt };
}

export async function syncReturnBalance(
  db: AppDatabase,
  userId: string,
  accountId: string,
  scope: IntentsReturnScope,
  assetId: string,
): Promise<void> {
  if (scope === "confidential") {
    await synchronizePrivateInventory(db, userId);
  } else {
    await synchronizePublicToken(db, userId, accountId, assetId);
  }
}

/**
 * Reserves one held token for return to the owner's wallet, as held or swapped to the owner's chosen NEAR token
 * (`payoutAssetId`, null for as held). Only an agent whose funds the owner is claiming qualifies.
 */
export async function prepareWalletReturn(
  db: AppDatabase,
  userId: string,
  agentId: string,
  scope: IntentsReturnScope,
  assetId: string,
  requestId: string,
  payoutAssetId: string | null = null,
): Promise<LedgerAction> {
  const payout = payoutAssetId ?? assetId;
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  if (existing) {
    if (existing.agentId !== agentId || existing.kind !== "defi") {
      throw new ExecutionError("conflict", "This return request belongs to another action.");
    }
    await walletReturnRecord(db, existing);
    return existing;
  }
  const agent = await ownedAgent(db, userId, agentId);
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (agent.claimRequestedAt === null || agent.status === "running" || !owner) {
    throw new ExecutionError("not_ready", "Claim the agent's funds before returning them to your wallet.");
  }
  if (!key?.activatedAt || !key.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "Agent trading access is needed to return these funds. Set it up in Settings.",
    );
  }
  const session = await privateBalanceToken(db, userId);
  if (scope === "confidential" && !session) {
    throw new ExecutionError("not_ready", "Connect your private balance to return these funds.");
  }
  await syncReturnBalance(db, userId, owner.accountId, scope, assetId);
  const units = await unreservedOwnedUnits(db, userId, agentId, scope, assetId);
  if (units <= 0n) {
    throw new ExecutionError("conflict", "This token has no unreserved balance left to return.");
  }
  const policy = policySchema.parse(JSON.parse(agent.policyJson));
  const { quote, saved, expiresAt } = await quoteWalletReturn({
    accountId: owner.accountId,
    scope,
    assetId,
    payoutAssetId: payout,
    units,
    slippageBps: policy.maxSlippageBps,
    maximumProviderFeeBps: policy.maxProviderFeeBps,
    requestId,
    session: session ?? undefined,
  });
  const notional = BigInt(quote.inputMicroUsd ?? "0");
  return userTransaction(db, userId, async (tx) => {
    const current = await ownedAgent(tx, userId, agentId);
    if (current.revision !== agent.revision || current.claimRequestedAt === null) {
      throw new ExecutionError("conflict", "The agent changed while its return was prepared.");
    }
    const venueId = WALLET_RETURN_VENUES[scope];
    const permissionHash = await confirmExecutionPermission(tx, userId, {
      agentId,
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      scope,
      venueId,
      signingPublicKey: key.publicKey,
      operations: ["transfer"],
      assetIds: payout === assetId ? [assetId] : [assetId, payout],
      instruments: [],
      recipients: [owner.accountId],
      expiresAt: null,
    });
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId,
      agentId,
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      walletReturn: true,
      ...(payout === assetId ? {} : { payoutAssetId: payout }),
      scope,
      operation: "transfer",
      venueId,
      permissionHash,
      cash: [{ assetId, maxDebitUnits: quote.inputUnits, minCreditUnits: "0" }],
      positions: [],
      // A positive bound for the ledger; a return never counts against spending limits.
      notionalMicroUsd: (notional > 0n ? notional : 1n).toString(),
      slippageBps: policy.maxSlippageBps,
      providerFeeBps: quote.appFeeBps,
      quoteId: saved.order.depositAddress,
      quoteHash: quote.quoteHash,
      payloadHash: saved.order.payloadHash,
      recipient: owner.accountId,
      expiresAt,
    });
    const action = await reserveDefiExecution(tx, userId, plan);
    verifiedWalletReturnQuote(action, saved, owner.accountId, Date.now());
    await executionEvent(tx, action, "wallet_return_prepared", await databaseTime(tx), saved);
    return action;
  });
}
