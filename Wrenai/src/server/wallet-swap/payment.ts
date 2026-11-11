import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { walletAllocatedUnits } from "@/server/agents/token-budgets";
import type { AppDatabase } from "@/server/db/client";
import { manualTrades } from "@/server/db/manual-schema";
import { users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { executionHash } from "@/server/execution/records";
import { callViewFunction, finalBlockTime, readFinalTransaction } from "@/server/near/rpc";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import {
  type WalletPaymentView,
  walletPaymentQuoteSchema,
  walletPaymentRequestSchema,
} from "@/shared/chat-payment";
import { NEAR_TX_HASH } from "@/shared/manual-trading";
import { tokenUnitsSchema } from "@/shared/token-units";
import { WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";
import { proveWalletPayment } from "./payment-proof";

type Row = typeof walletSwaps.$inferSelect;
const paymentOnly = sql`${walletSwaps.quoteJson}::jsonb ->> 'kind' = 'payment'`;
const walletPaymentId = z.strictObject({ id: z.uuid() });
const proofInput = walletPaymentId.extend({ transactionHash: NEAR_TX_HASH });
const MAX_NEAR_UNITS = (1n << 128n) - 1n;

function paymentView(row: Row): WalletPaymentView {
  if (row.state === "refunded") {
    throw new ExecutionError("conflict", "The payment status could not be verified.");
  }
  return {
    id: row.id,
    state: row.state === "quoted" && row.expiresAt <= Date.now() ? "expired" : row.state,
    expiresAt: row.expiresAt,
    transactionHash: row.transactionHash,
    quote: walletPaymentQuoteSchema.parse(JSON.parse(row.quoteJson)),
  };
}

async function ownedPayment(db: AppDatabase, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(walletSwaps)
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, id), paymentOnly))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "This wallet payment could not be found.");
  }
  return row;
}

async function recipientStorage(contract: string, recipient: string): Promise<string | null> {
  try {
    const result = await callViewFunction(contract, "storage_balance_of", { account_id: recipient });
    if (result.value !== null) {
      z.object({ total: tokenUnitsSchema }).parse(result.value);
      return null;
    }
    return z
      .object({ min: tokenUnitsSchema })
      .parse((await callViewFunction(contract, "storage_balance_bounds", {})).value).min;
  } catch (error) {
    // Some fungible tokens do not implement storage registration. Only an explicit missing method is optional.
    if (
      error instanceof Error &&
      error.message.startsWith(`${contract}.storage_balance_of failed:`) &&
      /MethodNotFound|method not found/i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

async function checkPayment(
  db: AppDatabase,
  userId: string,
  accountId: string,
  request: z.infer<typeof walletPaymentRequestSchema>,
): Promise<WalletPaymentView["quote"]> {
  const native = request.assetId === WALLET_SWAP_NATIVE_OUTPUT;
  const [holding, allocated, near, nearAllocated] = await Promise.all([
    walletTokenHolding(accountId, request.assetId),
    walletAllocatedUnits(db, userId, accountId, request.assetId),
    native ? null : walletTokenHolding(accountId, WALLET_SWAP_NATIVE_OUTPUT),
    native ? 0n : walletAllocatedUnits(db, userId, accountId, WALLET_SWAP_NATIVE_OUTPUT),
  ]);
  const [whole = "0", fraction = ""] = request.amount.split(".");
  const digits = fraction.replace(/0+$/, "");
  if (digits.length > holding.decimals) {
    throw new ExecutionError("limit", "Enter an amount within the token's supported precision.");
  }
  const units = BigInt(whole + digits.padEnd(holding.decimals, "0"));
  if (units > MAX_NEAR_UNITS) {
    throw new ExecutionError("limit", "This payment exceeds the supported token amount.");
  }
  if (BigInt(holding.spendableUnits) - allocated < units) {
    throw new ExecutionError("insufficient_funds", `Your available ${holding.symbol} balance is too low.`);
  }
  let registration: string | null = null;
  if (!native) {
    const contract = request.assetId.slice("nep141:".length);
    registration = await recipientStorage(contract, request.recipient);
    if (!near || BigInt(near.spendableUnits) - nearAllocated < BigInt(registration ?? "0") + 1n) {
      throw new ExecutionError(
        "insufficient_funds",
        "You need more NEAR for fees or recipient registration.",
      );
    }
  }
  return {
    kind: "payment",
    request,
    accountId,
    symbol: holding.symbol,
    units: units.toString(),
    registrationUnits: registration ?? "0",
    registerRecipient: registration !== null,
  };
}

export async function quoteWalletPayment(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletPaymentView> {
  const request = walletPaymentRequestSchema.parse(raw);
  const [[owner], [saved]] = await Promise.all([
    db.select({ accountId: users.accountId }).from(users).where(eq(users.id, userId)).limit(1),
    db
      .select()
      .from(walletSwaps)
      .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, request.requestId), paymentOnly))
      .limit(1),
  ]);
  if (saved) {
    const view = paymentView(saved);
    if (executionHash(view.quote.request) !== executionHash(request)) {
      throw new ExecutionError("conflict", "This request belongs to a different payment.");
    }
    return view;
  }
  if (!owner || request.recipient === owner.accountId) {
    throw new ExecutionError("conflict", "Choose another payment recipient.");
  }
  const quote = await checkPayment(db, userId, owner.accountId, request);
  const now = Date.now();
  await userTransaction(db, userId, async (tx) => {
    const [privatePayment] = await tx
      .select({ id: manualTrades.id })
      .from(manualTrades)
      .where(
        and(
          eq(manualTrades.userId, userId),
          eq(manualTrades.id, request.requestId),
          sql`${manualTrades.intentJson}::jsonb ->> 'kind' = 'payment'`,
        ),
      )
      .limit(1);
    if (privatePayment) {
      throw new ExecutionError("conflict", "This payment already has a private review.");
    }
    await tx
      .insert(walletSwaps)
      .values({
        id: request.requestId,
        userId,
        accountId: owner.accountId,
        quoteJson: JSON.stringify(quote),
        state: "quoted",
        expiresAt: now + 120_000,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });
  const view = paymentView(await ownedPayment(db, userId, request.requestId));
  if (executionHash(view.quote.request) !== executionHash(request)) {
    throw new ExecutionError("conflict", "This request belongs to a different payment.");
  }
  return view;
}

export async function beginWalletPayment(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletPaymentView> {
  const { id } = walletPaymentId.parse(raw);
  const view = paymentView(await ownedPayment(db, userId, id));
  if (view.state !== "quoted") {
    throw new ExecutionError("conflict", "This payment was already started or expired.");
  }
  const fresh = await checkPayment(db, userId, view.quote.accountId, view.quote.request);
  if (executionHash(fresh) !== executionHash(view.quote)) {
    throw new ExecutionError("not_ready", "Token details or fees changed. Review a fresh payment.");
  }
  const now = Date.now();
  const [saved] = await db
    .update(walletSwaps)
    .set({ state: "signing", updatedAt: now })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, id),
        eq(walletSwaps.state, "quoted"),
        gt(walletSwaps.expiresAt, now),
        paymentOnly,
      ),
    )
    .returning();
  if (!saved) {
    throw new ExecutionError("conflict", "This payment was already started or expired.");
  }
  return paymentView(saved);
}

export async function recordWalletPayment(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletPaymentView> {
  const { id, transactionHash } = proofInput.parse(raw);
  const row = await ownedPayment(db, userId, id);
  if (row.transactionHash === transactionHash) {
    return paymentView(row);
  }
  if (row.state !== "signing") {
    throw new ExecutionError("conflict", "This payment is not waiting for a transaction.");
  }
  const { quote } = paymentView(row);
  const proof = proveWalletPayment(
    await readFinalTransaction(transactionHash, quote.accountId),
    quote,
    transactionHash,
  );
  if ((await finalBlockTime(proof.blockHash)) < row.updatedAt - 1000) {
    throw new ExecutionError("conflict", "This transaction predates the payment approval.");
  }
  const [saved] = await db
    .update(walletSwaps)
    .set({
      state: proof.succeeded ? "settled" : "failed",
      transactionHash,
      spentUnits: proof.succeeded ? quote.units : "0",
      receivedUnits: proof.succeeded ? quote.units : "0",
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, id),
        eq(walletSwaps.state, "signing"),
        paymentOnly,
      ),
    )
    .returning();
  const result = saved ?? (await ownedPayment(db, userId, id));
  if (result.transactionHash !== transactionHash) {
    throw new ExecutionError("conflict", "This payment already has another transaction.");
  }
  return paymentView(result);
}

export async function readWalletPayment(
  db: AppDatabase,
  userId: string,
  id: string,
): Promise<WalletPaymentView> {
  return paymentView(await ownedPayment(db, userId, z.uuid().parse(id)));
}
