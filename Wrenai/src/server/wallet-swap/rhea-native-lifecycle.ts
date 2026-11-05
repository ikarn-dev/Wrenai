import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { NearRpcError, readFinalTransaction } from "@/server/near/rpc";
import { walletSwapQuoteSchema } from "@/shared/wallet-swap";
import { verifyWalletSwapTransaction } from "./proof";
import { verifyRheaNativePayout } from "./rhea-native-proof";

export type WalletSwapRow = typeof walletSwaps.$inferSelect;

function rheaQuote(row: WalletSwapRow) {
  const quote = walletSwapQuoteSchema.parse(JSON.parse(row.quoteJson));
  if (quote.depositKind !== "rhea_native") {
    throw new ExecutionError("conflict", "This transaction is not a native NEAR swap.");
  }
  return quote;
}

async function ownedRow(db: AppDatabase, userId: string, id: string): Promise<WalletSwapRow> {
  const [row] = await db
    .select()
    .from(walletSwaps)
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, id)))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "This swap could not be found.");
  }
  return row;
}

/**
 * Durably binds the first wallet transaction hash before any RPC proof. A timeout can then be retried from the
 * saved hash; another hash can never replace an uncertain submission.
 */
export async function bindRheaNativeHash(
  db: AppDatabase,
  row: WalletSwapRow,
  transactionHash: string,
): Promise<WalletSwapRow> {
  if (row.transactionHash !== null) {
    if (row.transactionHash !== transactionHash) {
      throw new ExecutionError("conflict", "This swap already belongs to another wallet transaction.");
    }
    return row;
  }
  if (row.state !== "signing") {
    throw new ExecutionError("conflict", "This swap is not awaiting a wallet transaction.");
  }
  const [bound] = await db
    .update(walletSwaps)
    .set({ state: "submitted", transactionHash, updatedAt: Date.now() })
    .where(
      and(
        eq(walletSwaps.userId, row.userId),
        eq(walletSwaps.id, row.id),
        eq(walletSwaps.state, "signing"),
        isNull(walletSwaps.transactionHash),
      ),
    )
    .returning();
  const current = bound ?? (await ownedRow(db, row.userId, row.id));
  if (current.transactionHash !== transactionHash) {
    throw new ExecutionError("conflict", "This swap already belongs to another wallet transaction.");
  }
  return current;
}

function proofPending(error: unknown): boolean {
  return error instanceof NearRpcError || (error instanceof ExecutionError && error.code === "not_ready");
}

/** Rechecks one bound RHEA transaction. Temporary RPC or incomplete-receipt failures keep it submitted. */
export async function reconcileRheaNativeSwap(
  db: AppDatabase,
  row: WalletSwapRow,
  knownTransaction?: unknown,
): Promise<WalletSwapRow> {
  if (row.state !== "submitted" || row.transactionHash === null) {
    return row;
  }
  const quote = rheaQuote(row);
  let proof: ReturnType<typeof verifyRheaNativePayout>;
  try {
    const transaction =
      knownTransaction ?? (await readFinalTransaction(row.transactionHash, quote.accountId, true));
    verifyWalletSwapTransaction(transaction, quote, row.transactionHash, true);
    proof = verifyRheaNativePayout(transaction, quote);
  } catch (error) {
    if (proofPending(error)) {
      return row;
    }
    throw error;
  }
  const [updated] = await db
    .update(walletSwaps)
    .set({
      state: proof.state,
      spentUnits: proof.spentUnits,
      receivedUnits: proof.receivedUnits,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(walletSwaps.userId, row.userId),
        eq(walletSwaps.id, row.id),
        eq(walletSwaps.state, "submitted"),
        eq(walletSwaps.transactionHash, row.transactionHash),
      ),
    )
    .returning();
  const current = updated ?? (await ownedRow(db, row.userId, row.id));
  if (current.transactionHash !== row.transactionHash) {
    throw new ExecutionError("conflict", "This swap belongs to another wallet transaction.");
  }
  return current;
}

/** Binds a wallet hash, then performs the first idempotent reconciliation attempt. */
export async function submitRheaNativeSwap(
  db: AppDatabase,
  row: WalletSwapRow,
  transactionHash: string,
  fromRecovery?: true,
): Promise<WalletSwapRow> {
  let transaction: unknown;
  // A pasted hash may be a typo or belong to another transfer. Verify it before claiming the swap.
  if (fromRecovery && row.state === "signing" && row.transactionHash === null) {
    const quote = rheaQuote(row);
    try {
      transaction = await readFinalTransaction(transactionHash, quote.accountId, true);
      verifyWalletSwapTransaction(transaction, quote, transactionHash, true);
    } catch (error) {
      if (proofPending(error)) {
        throw new ExecutionError("not_ready", "Transaction not verified yet. Check the hash and try again.");
      }
      throw error;
    }
  }
  return reconcileRheaNativeSwap(db, await bindRheaNativeHash(db, row, transactionHash), transaction);
}
