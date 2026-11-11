import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions, executionEvents, executionFills } from "@/server/db/execution-schema";
import { manualTrades } from "@/server/db/manual-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { ExecutionError } from "@/server/execution/contracts";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash, ownedLedgerAction } from "@/server/execution/records";
import { synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import { readPaymentTopUp } from "@/server/wallet-swap/private-top-up";
import {
  type ManualPreview,
  manualConfirmationSchema,
  manualQuoteInputSchema,
  NEAR_TX_HASH,
} from "@/shared/manual-trading";
import { tokenUnitsSchema } from "@/shared/token-units";
import { prepareManualPayment } from "./payment";
import { prepareManualPerps } from "./perps";
import { prepareManualPerpsDeposit } from "./perps-funding";
import { prepareManualPerpsReturn } from "./perps-return";
import { manualEnvelope, manualEnvelopeSchema, ownedManualTrade } from "./record";
import { reserveManualTrade } from "./reserve";
import { prepareManualRhea } from "./rhea";
import { prepareManualSpot } from "./spot";
import { manualSubject } from "./subject";
import { prepareManualWalletReturn } from "./wallet-return";

function needsPairReview(row: { source: string }, preview: ManualPreview): boolean {
  return row.source === "jarvis" && preview.intent.kind === "spot" && !preview.pairVerified;
}

const returnTerminalSchema = z.object({
  amountIn: tokenUnitsSchema,
  amountOut: tokenUnitsSchema,
  refundedAmount: tokenUnitsSchema,
  destinationTxHashes: z.array(z.string()).optional(),
});

/** A settled wallet return as 1Click finally accounted for it, with the public payout transaction. */
async function walletReturnResult(
  db: AppDatabase,
  userId: string,
  actionId: string,
  preview: ManualPreview,
  payment = false,
): Promise<ManualPreview> {
  const [terminal] = await db
    .select({ detailJson: executionEvents.detailJson })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, userId),
        eq(executionEvents.actionId, actionId),
        eq(executionEvents.kind, payment ? "payment_terminal" : "wallet_return_terminal"),
      ),
    )
    .limit(1);
  if (!terminal) {
    throw new ExecutionError("not_ready", "The final transfer receipt is not recorded yet.");
  }
  const result = returnTerminalSchema.parse(JSON.parse(terminal.detailJson));
  const hash = NEAR_TX_HASH.safeParse(result.destinationTxHashes?.[0]);
  return {
    ...preview,
    status: result.amountIn === "0" ? "refunded" : "settled",
    actionId,
    execution: {
      spentUnits: result.amountIn,
      receivedUnits: result.amountOut,
      refundedUnits: result.refundedAmount,
    },
    ...(hash.success ? { transactionHash: hash.data } : {}),
  };
}

export async function readManualPreview(db: AppDatabase, userId: string, id: string): Promise<ManualPreview> {
  const row = await ownedManualTrade(db, userId, id),
    envelope = manualEnvelope(row);
  if (row.actionId) {
    const [action] = await db
      .select({
        status: executionActions.status,
        kind: executionActions.kind,
        inputUnits: executionActions.inputUnits,
      })
      .from(executionActions)
      .where(and(eq(executionActions.id, row.actionId), eq(executionActions.userId, userId)))
      .limit(1);
    if (!action) {
      throw new ExecutionError("conflict", "The confirmed order is unavailable.");
    }
    if (action.status === "settled" && action.kind === "swap") {
      const [filled] = await db
        .select({
          input: sql<string>`coalesce(sum(${executionFills.inputUnits}),0)::text`,
          output: sql<string>`coalesce(sum(${executionFills.outputUnits}),0)::text`,
        })
        .from(executionFills)
        .where(and(eq(executionFills.actionId, row.actionId), eq(executionFills.userId, userId)));
      const spent = filled?.input ?? "0",
        received = filled?.output ?? "0";
      return {
        ...envelope.preview,
        status: spent === "0" ? "refunded" : "settled",
        actionId: row.actionId,
        execution: {
          spentUnits: spent,
          receivedUnits: received,
          refundedUnits: ((action.inputUnits ?? 0n) - BigInt(spent)).toString(),
        },
      };
    }
    if (action.status === "settled" && (envelope.kind === "wallet_return" || envelope.kind === "payment")) {
      return walletReturnResult(db, userId, row.actionId, envelope.preview, envelope.kind === "payment");
    }
    if (action.status === "settled" && action.kind === "defi") {
      const [receipt] = await db
        .select({ id: executionReceipts.id })
        .from(executionReceipts)
        .where(and(eq(executionReceipts.actionId, row.actionId), eq(executionReceipts.userId, userId)))
        .limit(1);
      if (!receipt) {
        return {
          ...envelope.preview,
          status: envelope.kind === "perps" ? "no_fill" : "refunded",
          actionId: row.actionId,
        };
      }
    }
    return { ...envelope.preview, status: action.status, actionId: row.actionId };
  }
  return {
    ...envelope.preview,
    status:
      row.status === "cancelled"
        ? "cancelled"
        : row.expiresAt <= Date.now() || needsPairReview(row, envelope.preview)
          ? "expired"
          : "quoted",
  };
}
export async function quoteManualTrade(
  db: AppDatabase,
  userId: string,
  raw: unknown,
  fromPaymentTopUp = false,
): Promise<ManualPreview> {
  const input = manualQuoteInputSchema.parse(raw),
    intentHash = executionHash(input.intent);
  const page =
    input.intent.kind === "perps_funding"
      ? "perps"
      : input.intent.kind === "wallet_return"
        ? "portfolio"
        : input.intent.kind;
  // Returns to the wallet start only from Portfolio, never from a chat extraction.
  if (input.source !== page && (input.source !== "jarvis" || page === "portfolio")) {
    throw new ExecutionError("conflict", "Choose the matching trading page.");
  }
  const [repeated] = await db
    .select()
    .from(manualTrades)
    .where(and(eq(manualTrades.userId, userId), eq(manualTrades.requestId, input.requestId)))
    .limit(1);
  if (repeated) {
    if (repeated.intentHash !== intentHash) {
      throw new ExecutionError("conflict", "This request already belongs to a different trade.");
    }
    return readManualPreview(db, userId, repeated.id);
  }
  const topUp = input.intent.kind === "payment" ? await readPaymentTopUp(db, userId, input.requestId) : null;
  if (
    topUp &&
    (!fromPaymentTopUp ||
      topUp.state !== "settled" ||
      topUp.quote.privateTopUp.reviewRequired ||
      executionHash(topUp.quote.privateTopUp.intent) !== intentHash)
  ) {
    throw new ExecutionError("conflict", "Finish the wallet top-up from its payment card.");
  }
  const subjectId = await manualSubject(db, userId);
  const envelope =
    input.intent.kind === "spot"
      ? input.intent.balance === "native_near"
        ? await prepareManualRhea(db, userId, input.requestId, subjectId, input.intent)
        : await prepareManualSpot(db, userId, input.requestId, subjectId, input.intent)
      : input.intent.kind === "perps_funding"
        ? input.intent.direction === "deposit"
          ? await prepareManualPerpsDeposit(db, userId, input.requestId, subjectId, input.intent)
          : await prepareManualPerpsReturn(db, userId, input.requestId, subjectId, input.intent)
        : input.intent.kind === "wallet_return"
          ? await prepareManualWalletReturn(db, userId, input.requestId, subjectId, input.intent)
          : input.intent.kind === "payment"
            ? await prepareManualPayment(
                db,
                userId,
                input.requestId,
                subjectId,
                input.intent,
                topUp?.quote.privateTopUp.maximumDebitUnits,
              )
            : await prepareManualPerps(db, userId, input.requestId, subjectId, input.intent);
  const { bindingHash: _binding, ...preview } = envelope.preview;
  const bound = { ...preview, ...(input.intent.kind === "spot" ? { pairVerified: true } : {}) };
  const bindingHash = executionHash({ preview: bound, plan: envelope.plan, prepared: envelope.prepared });
  const saved = manualEnvelopeSchema.parse({ ...envelope, preview: { ...bound, bindingHash } });
  await userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx);
    if (input.intent.kind === "payment") {
      const [publicPayment] = await tx
        .select({ id: walletSwaps.id })
        .from(walletSwaps)
        .where(
          and(
            eq(walletSwaps.userId, userId),
            eq(walletSwaps.id, input.requestId),
            sql`(${walletSwaps.quoteJson}::jsonb ->> 'kind' = 'payment'
              OR (${walletSwaps.quoteJson}::jsonb ? 'privateTopUp' AND NOT ${Boolean(topUp)}))`,
          ),
        )
        .limit(1);
      if (publicPayment) {
        throw new ExecutionError("conflict", "This payment already has a public wallet review.");
      }
    }
    if (saved.plan.expiresAt <= now || saved.plan.expiresAt > now + 300_000) {
      throw new ExecutionError("not_ready", "The quote expired while preparing. Request a fresh quote.");
    }
    const [existing] = await tx
      .select()
      .from(manualTrades)
      .where(and(eq(manualTrades.userId, userId), eq(manualTrades.requestId, input.requestId)))
      .limit(1);
    if (existing) {
      if (existing.intentHash !== intentHash) {
        throw new ExecutionError("conflict", "This request belongs to another trade.");
      }
      return;
    }
    await tx.insert(manualTrades).values({
      id: input.requestId,
      userId,
      subjectId,
      requestId: input.requestId,
      intentHash,
      intentJson: JSON.stringify(input.intent),
      previewJson: JSON.stringify(saved),
      bindingHash,
      source: input.source,
      status: "quoted",
      revision: 1,
      expiresAt: saved.plan.expiresAt,
      createdAt: now,
    });
  });
  return readManualPreview(db, userId, input.requestId);
}
export async function confirmManualTrade(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ManualPreview> {
  const input = manualConfirmationSchema.parse(raw),
    initial = await ownedManualTrade(db, userId, input.id);
  if (initial.bindingHash !== input.bindingHash || initial.revision !== input.revision) {
    throw new ExecutionError("conflict", "Review the current quote before confirming.");
  }
  if (initial.status === "confirmed") {
    return readManualPreview(db, userId, initial.id);
  }
  const envelope = manualEnvelope(initial);
  if (needsPairReview(initial, envelope.preview)) {
    throw new ExecutionError("not_ready", "Request a new quote with the exact tokens.");
  }
  if (initial.status !== "quoted" || initial.expiresAt <= Date.now()) {
    throw new ExecutionError("not_ready", "This quote expired or was dismissed. Review a fresh quote.");
  }
  if (envelope.kind === "intents" || envelope.kind === "wallet_return" || envelope.kind === "payment") {
    await synchronizePrivateInventory(db, userId);
  } else if (envelope.kind === "rhea") {
    await synchronizeNativeInventory(db, userId, [envelope.plan.inputAssetId, envelope.plan.outputAssetId]);
  } else {
    await synchronizePerpsInventory(db, userId, initial.subjectId);
    if (envelope.kind !== "perps") {
      await synchronizePrivateInventory(db, userId);
    }
  }
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedManualTrade(tx, userId, input.id),
      now = await databaseTime(tx);
    if (row.status === "confirmed") {
      return;
    }
    if (
      row.status !== "quoted" ||
      row.expiresAt <= now ||
      row.bindingHash !== input.bindingHash ||
      row.revision !== input.revision
    ) {
      throw new ExecutionError("conflict", "The quote expired or changed. Review it again.");
    }
    const currentEnvelope = manualEnvelope(row);
    const topUp = currentEnvelope.kind === "payment" ? await readPaymentTopUp(tx, userId, row.id) : null;
    if (
      topUp &&
      (topUp.state !== "settled" ||
        topUp.quote.privateTopUp.reviewRequired ||
        Date.parse(topUp.quote.privateTopUp.requestDeadline) <= now ||
        executionHash(topUp.quote.privateTopUp.intent) !== row.intentHash ||
        BigInt(currentEnvelope.preview.inputUnits) > BigInt(topUp.quote.privateTopUp.maximumDebitUnits))
    ) {
      throw new ExecutionError("conflict", "The funded payment requires a fresh review.");
    }
    const action = await reserveManualTrade(
      tx,
      row,
      currentEnvelope,
      now,
      topUp?.quote.privateTopUp.signingPublicKey,
    );
    const consumed = await tx
      .update(manualTrades)
      .set({ status: "confirmed", actionId: action.id, confirmedAt: now })
      .where(
        and(
          eq(manualTrades.id, row.id),
          eq(manualTrades.userId, userId),
          eq(manualTrades.status, "quoted"),
          eq(manualTrades.revision, input.revision),
          eq(manualTrades.bindingHash, input.bindingHash),
        ),
      )
      .returning({ id: manualTrades.id });
    if (consumed.length !== 1) {
      throw new ExecutionError("conflict", "This confirmation was already consumed.");
    }
  });
  return readManualPreview(db, userId, input.id);
}
export async function dismissManualTrade(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = manualConfirmationSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedManualTrade(tx, userId, input.id);
    if (
      row.status === "cancelled" &&
      row.bindingHash === input.bindingHash &&
      row.revision === input.revision
    ) {
      return;
    }
    if (
      row.bindingHash !== input.bindingHash ||
      row.revision !== input.revision ||
      row.status === "confirmed"
    ) {
      throw new ExecutionError("conflict", "A confirmed trade cannot be dismissed or undone.");
    }
    await tx
      .update(manualTrades)
      .set({ status: "cancelled" })
      .where(and(eq(manualTrades.id, row.id), eq(manualTrades.userId, userId)));
  });
}

/**
 * Advances only the exact owner-confirmed wallet claim. A possibly submitted action is reconciliation-only, so a
 * failed workflow can recover without another signature or provider submission. A still-reserved confirmation may
 * start its original action; its single-use confirmation already owns that authorization.
 */
export async function checkManualWalletReturn(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ManualPreview> {
  const input = manualConfirmationSchema.parse(raw),
    row = await ownedManualTrade(db, userId, input.id),
    envelope = manualEnvelope(row);
  if (
    row.bindingHash !== input.bindingHash ||
    row.revision !== input.revision ||
    row.status !== "confirmed" ||
    row.actionId === null ||
    envelope.kind !== "wallet_return"
  ) {
    throw new ExecutionError("conflict", "This status check does not match the confirmed claim.");
  }
  await advanceClaimAction(db, userId, row.actionId, true);
  return readManualPreview(db, userId, row.id);
}

const IN_FLIGHT_STATUSES = ["reserved", "submitting", "submitted", "unknown"] as const;
const RECOVERY_LIMIT = 5;

/**
 * Advances one claim's action unless a live worker holds its lease. `reserved` may execute only when the caller
 * allows it; everything else is reconciliation-only. Returns whether the action is now final.
 */
async function advanceClaimAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  allowExecute: boolean,
): Promise<boolean> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.status === "settled" || action.status === "cancelled") {
    return true;
  }
  if (action.status === "reserved" && !allowExecute) {
    return false;
  }
  const now = await databaseTime(db);
  if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
    return false;
  }
  await advanceLedgerAction(
    db,
    userId,
    action.id,
    action.status === "reserved" ? "execute" : "reconcile_only",
  );
  const after = await ownedLedgerAction(db, userId, actionId);
  return after.status === "settled" || after.status === "cancelled";
}

/**
 * Settles confirmed private-balance claims whose workflow stopped after the payout landed. Reconciliation-only:
 * it never signs or submits, so a page view can run it. Returns how many it finished and how many wallet returns,
 * agent claims included, are still in flight.
 */
export async function recoverManualWalletReturns(
  db: AppDatabase,
  userId: string,
): Promise<{ readonly resolved: number; readonly inFlight: number }> {
  const records = await db
    .select({ trade: manualTrades })
    .from(manualTrades)
    .innerJoin(
      executionActions,
      and(eq(executionActions.userId, manualTrades.userId), eq(executionActions.id, manualTrades.actionId)),
    )
    .where(
      and(
        eq(manualTrades.userId, userId),
        eq(manualTrades.source, "portfolio"),
        eq(manualTrades.status, "confirmed"),
        inArray(executionActions.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .orderBy(desc(manualTrades.createdAt))
    .limit(RECOVERY_LIMIT);
  let resolved = 0;
  for (const { trade } of records) {
    if (
      trade.actionId !== null &&
      manualEnvelope(trade).kind === "wallet_return" &&
      (await advanceClaimAction(db, userId, trade.actionId, false))
    ) {
      resolved += 1;
    }
  }
  // Agent claims count too: their own workflow settles them, and a drop in this number tells the page to refresh.
  const [open] = await db
    .select({ count: sql`count(*)::int` })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        inArray(executionActions.status, [...IN_FLIGHT_STATUSES]),
        sql`EXISTS (SELECT 1 FROM ${executionEvents} e WHERE e.user_id = ${executionActions.userId}
          AND e.action_id = ${executionActions.id} AND e.kind = 'wallet_return_prepared')`,
      ),
    );
  return {
    resolved,
    inFlight: z
      .number()
      .int()
      .nonnegative()
      .parse(open?.count ?? 0),
  };
}
