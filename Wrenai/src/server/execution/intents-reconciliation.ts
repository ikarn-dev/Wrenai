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
// Live 1Click sends these as null until a deposit is final (observed Nov 2026 on PENDING_DEPOSIT/PROCESSING), while
// its SDK types them as optional strings. Accept both and read null as absent, so every reconciler's "not yet
// accounted" checks (`=== undefined`) still fail closed.
const absent = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value): z.output<T> | undefined => value ?? undefined);
const hashes = absent(z.array(z.object({ hash: z.string().min(1).max(200) })).max(100));
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
    amountIn: absent(tokenUnitsSchema),
    amountOut: absent(tokenUnitsSchema),
    amountInUsd: absent(decimal),
    amountOutUsd: absent(decimal),
    destinationChainTxHashes: hashes,
    originChainTxHashes: hashes,
    depositedAmount: absent(tokenUnitsSchema),
    refundedAmount: absent(tokenUnitsSchema),
    // 1Click's final accounting references. These are not the singular hash returned by /v0/submit-intent;
    // a real successful wallet payout carried different values (Nov 2026). The submit hash stays in its audit event.
    intentHashes: z.array(z.string().min(1).max(128)).max(100),
  }),
});

/**
 * The stored signed quote, once a /v0/status echo is shown to be that same signed quote. 1Click re-serializes
 * the echo (no correlationId, unset request fields as null, extra request fields), so its content and hash
 * differ from the stored copy. Its Ed25519 signature is deterministic over the signed content, so an echo
 * carrying the stored quote's exact signature, timestamp and deposit address is that quote. Reconcilers then
 * re-verify the stored copy against its stored hash, unchanged.
 */
export function confirmedStatusQuote(stored: unknown, echoed: unknown): unknown {
  const identity = z.object({
    signature: z.string().min(1).max(512),
    timestamp: z.iso.datetime(),
    quote: z.object({ depositAddress: z.string().min(1).max(128) }),
  });
  const saved = identity.parse(stored),
    provider = identity.parse(echoed);
  // Instants, not strings: the echo may re-format the same timestamp.
  if (
    saved.signature !== provider.signature ||
    Date.parse(saved.timestamp) !== Date.parse(provider.timestamp) ||
    saved.quote.depositAddress !== provider.quote.depositAddress
  ) {
    throw new ExecutionError("conflict", "The provider status refers to a different signed quote.");
  }
  return stored;
}

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
  verifiedStoredQuote(
    action,
    { ...prepared, providerQuote: confirmedStatusQuote(prepared.providerQuote, status.quoteResponse) },
    owner,
    prepared.quotedAt,
  );
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
