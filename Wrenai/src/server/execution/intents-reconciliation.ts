import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { tokenUnitsSchema } from "@/shared/token-units";
import { recordExecutionFill, settleExecution } from "./accounting";
import { ExecutionError } from "./contracts";
import { readPreparedOrder, verifiedStoredQuote } from "./intents-order";
import { quoteMicroUsd } from "./oneclick-quote";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, executionHash, ownedExecution, requireLease } from "./records";
import { tradingResponseJson } from "./trading-http";

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,36})?$/);
export const intentsStatusSchema = z.object({
  quoteResponse: z.unknown(),
  status: z.enum([
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ]),
  updatedAt: z.iso.datetime(),
  swapDetails: z.object({
    amountIn: tokenUnitsSchema.optional(),
    amountOut: tokenUnitsSchema.optional(),
    amountInUsd: decimal.optional(),
    amountOutUsd: decimal.optional(),
    destinationChainTxHashes: z
      .array(z.object({ hash: z.string().min(1).max(200) }))
      .max(100)
      .optional(),
    depositedAmount: tokenUnitsSchema.optional(),
    refundedAmount: tokenUnitsSchema.optional(),
    intentHashes: z.array(z.string().min(1).max(128)).max(100),
  }),
});

export async function readIntentsProviderStatus(depositAddress: string): Promise<unknown> {
  const { ONECLICK_JWT } = process.env;
  const credential = z.string().trim().min(1).max(8000).safeParse(ONECLICK_JWT);
  if (!credential.success) {
    throw new ExecutionError("not_ready", "The trading provider credential is not configured.");
  }
  const url = new URL("https://1click.chaindefuser.com/v0/status");
  url.searchParams.set("depositAddress", depositAddress);
  return tradingResponseJson(
    await fetch(url, {
      headers: { "User-Agent": "wrenai/0.1", "X-API-Key": credential.data },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    }),
    256_000,
  );
}

/** Status is an authenticated provider assertion, not an independently verified public FAR receipt. */
export async function reconcileIntentsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  leaseToken: string,
): Promise<"pending" | "settled"> {
  const action = await ownedExecution(db, userId, actionId);
  if (action.status === "settled") {
    // Inventory refresh can fail after a committed receipt. Retrying must still release its holds safely.
    if (action.reservationReleasedAt === null) {
      await synchronizePrivateInventory(db, userId);
    }
    return "settled";
  }
  requireLease(action, leaseToken, await databaseTime(db));
  if (action.scope !== "confidential" || !["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("not_ready", "Only an existing confidential submission can be reconciled.");
  }
  const prepared = await readPreparedOrder(db, action);
  const owner = z.object({ quoteRequest: z.object({ recipient: z.string() }) }).parse(prepared.providerQuote)
    .quoteRequest.recipient;
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(prepared.depositAddress));
  // Revalidate the original quote at its recorded signing time; recovery must work after quote/key expiry or stop.
  verifiedStoredQuote(action, { ...prepared, providerQuote: status.quoteResponse }, owner, prepared.quotedAt);
  const deposit = z
    .object({ quote: z.object({ depositAddress: z.literal(prepared.depositAddress) }) })
    .parse(status.quoteResponse);
  if (!deposit.quote.depositAddress || Date.parse(status.updatedAt) > Date.now() + 1000) {
    throw new ExecutionError("conflict", "The provider status is inconsistent with this reserved transfer.");
  }
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    // FAILED/PENDING/expired quotes never establish that signed input is safe to spend again.
    return "pending";
  }
  const detail = status.swapDetails;
  const [submitted] = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, userId),
        eq(executionEvents.actionId, actionId),
        eq(executionEvents.kind, "intents_submitted"),
      ),
    )
    .limit(1);
  if (
    submitted &&
    !detail.intentHashes.includes(
      z.object({ intentHash: z.string() }).parse(JSON.parse(submitted.detailJson)).intentHash,
    )
  ) {
    throw new ExecutionError("conflict", "The completed swap does not include the acknowledged transfer.");
  }
  if (
    detail.amountIn === undefined ||
    detail.amountOut === undefined ||
    detail.depositedAmount === undefined ||
    detail.refundedAmount === undefined ||
    BigInt(detail.depositedAmount) !== action.inputUnits ||
    BigInt(detail.amountIn) + BigInt(detail.refundedAmount) !== action.inputUnits ||
    detail.intentHashes.length === 0
  ) {
    throw new ExecutionError(
      "not_ready",
      "The terminal provider status does not account for the complete deposit and refund.",
    );
  }
  const filled = BigInt(detail.amountIn);
  const output = BigInt(detail.amountOut);
  if (
    (filled === 0n) !== (output === 0n) ||
    (status.status === "SUCCESS" && filled === 0n) ||
    (status.status === "REFUNDED" && BigInt(detail.refundedAmount) === 0n)
  ) {
    throw new ExecutionError(
      "conflict",
      "The terminal amounts do not match the provider's completion status.",
    );
  }
  const value = filled === 0n ? 0n : quoteMicroUsd(decimal.parse(detail.amountInUsd), true);
  if (filled > 0n && (value <= 0n || value > action.notionalMicroUsd)) {
    throw new ExecutionError("limit", "The confirmed debit cannot be valued within its reserved ceiling.");
  }
  const receiptId = `oneclick:${prepared.depositAddress}`;
  await userTransaction(db, userId, async (tx) => {
    const current = await ownedExecution(tx, userId, actionId);
    requireLease(current, leaseToken, await databaseTime(tx));
    const [proof] = await tx
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.actionId, actionId),
          eq(executionEvents.userId, userId),
          eq(executionEvents.kind, "intents_terminal"),
        ),
      )
      .limit(1);
    const evidence = {
      provider: "oneclick",
      depositAddress: prepared.depositAddress,
      status: status.status,
      amountIn: detail.amountIn,
      amountOut: detail.amountOut,
      refundedAmount: detail.refundedAmount,
      amountInUsd: detail.amountInUsd ?? null,
      intentHashes: detail.intentHashes.toSorted(),
    };
    if (proof && executionHash(JSON.parse(proof.detailJson)) !== executionHash(evidence)) {
      throw new ExecutionError("conflict", "A different final provider receipt was already recorded.");
    }
    if (!proof) {
      await executionEvent(tx, current, "intents_terminal", await databaseTime(tx), evidence);
    }
    if (filled > 0n) {
      await recordExecutionFill(tx, userId, actionId, leaseToken, {
        providerEventId: receiptId,
        inputUnits: detail.amountIn,
        outputUnits: detail.amountOut,
        inputValueMicroUsd: value.toString(),
        // Included fees cannot be itemized independently by this status response; do not invent a second charge.
        feeMicroUsd: null,
        occurredAt: Date.parse(status.updatedAt),
      });
    }
    await settleExecution(tx, userId, actionId, leaseToken, {
      providerReceiptId: receiptId,
      refundedInputUnits: detail.refundedAmount,
    });
  });
  await synchronizePrivateInventory(db, userId);
  return "settled";
}
