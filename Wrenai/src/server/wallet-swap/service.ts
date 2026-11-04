import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { intentsStatusSchema, readIntentsProviderStatus } from "@/server/execution/intents-reconciliation";
import { oneClickJson, verifiedProviderQuote } from "@/server/execution/oneclick-quote";
import { executionHash } from "@/server/execution/records";
import { reportUnexpectedError } from "@/server/http/unexpected-error";
import { readFinalTransaction } from "@/server/near/rpc";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { tokenUnits } from "@/server/research/decimal";
import { intentTokens } from "@/server/research/intents";
import { tradeAssetSchema } from "@/shared/trade-preview";
import {
  WALLET_SWAP_INPUT,
  type WalletSwapQuote,
  type WalletSwapView,
  WRAP_STORAGE_YOCTO,
  walletSwapIdSchema,
  walletSwapProofSchema,
  walletSwapQuoteSchema,
  walletSwapRequestSchema,
} from "@/shared/wallet-swap";
import { verifyWalletSwapTransaction } from "./proof";

// The deposit must reach 1Click before its quote deadline; the card stops offering Confirm a minute earlier so a
// slow wallet approval still lands in time.
const QUOTE_LIFETIME_MS = 10 * 60_000;
const SIGNING_MARGIN_MS = 60_000;
// Left in the wallet for the transaction's gas, so the swap never empties the account (about 0.009 NEAR is
// enough for 90 Tgas at current prices).
const GAS_RESERVE_YOCTO = 10_000_000_000_000_000_000_000n;

type Row = typeof walletSwaps.$inferSelect;

function view(row: Row, now = Date.now()): WalletSwapView {
  const quote = walletSwapQuoteSchema.parse(JSON.parse(row.quoteJson));
  const unsigned = row.state === "quoted" || row.state === "signing";
  return {
    id: row.id,
    state: unsigned && now >= row.expiresAt ? "expired" : row.state,
    quote,
    transactionHash: row.transactionHash,
    receivedUnits: row.receivedUnits,
    expiresAt: row.expiresAt,
  };
}

async function ownedSwap(db: AppDatabase, userId: string, id: string): Promise<Row> {
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

async function ownerAccount(db: AppDatabase, userId: string): Promise<string> {
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) {
    throw new ExecutionError("not_found", "Sign in again before swapping.");
  }
  return owner.accountId;
}

/**
 * Quotes a swap paid from the wallet: a real 1Click quote (it reserves a deposit address; no funds move until
 * the wallet signs), verified against the exact request and its signature, then saved for review.
 */
export async function prepareWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletSwapView> {
  const request = walletSwapRequestSchema.parse(raw);
  const [existing] = await db
    .select()
    .from(walletSwaps)
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, request.requestId)))
    .limit(1);
  if (existing) {
    return view(existing);
  }
  const accountId = await ownerAccount(db, userId);
  const { tokens } = await intentTokens();
  const find = (assetId: string) => {
    const token = tokens.find((t) => t.assetId === assetId);
    if (!token) {
      throw new ExecutionError("not_ready", "Choose a token 1Click supports on NEAR.");
    }
    return tradeAssetSchema.parse({
      symbol: token.symbol,
      tokenSymbol: token.symbol,
      assetId: token.assetId,
      blockchain: token.blockchain,
      contractAddress: token.contractAddress ?? null,
      decimals: token.decimals,
    });
  };
  const wrapped = find(WALLET_SWAP_INPUT);
  const input = { ...wrapped, symbol: "NEAR", tokenSymbol: "NEAR" };
  const output = find(request.outputAssetId);
  const units = tokenUnits(request.amount, input.decimals);
  const holding = await walletTokenHolding(accountId, "native:near");
  if (BigInt(holding.spendableUnits) < units + BigInt(WRAP_STORAGE_YOCTO) + GAS_RESERVE_YOCTO) {
    throw new ExecutionError(
      "insufficient_funds",
      "Your wallet doesn't have enough NEAR for this swap plus about 0.011 NEAR for fees.",
    );
  }
  const now = Date.now();
  const quoteRequest: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: request.slippageBps,
    originAsset: WALLET_SWAP_INPUT,
    destinationAsset: output.assetId,
    amount: units.toString(),
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: accountId,
    refundTo: accountId,
    deadline: new Date(now + QUOTE_LIFETIME_MS).toISOString(),
    quoteWaitingTimeMs: 0,
    appFees: [],
  };
  const providerQuote = await oneClickJson("/v0/quote", quoteRequest);
  // The scope only labels the returned record; every routing field is checked against quoteRequest above.
  const verified = verifiedProviderQuote(providerQuote, quoteRequest, "intents", Date.now());
  if (verified.appFeeBps > request.maximumFeeBps) {
    throw new ExecutionError(
      "limit",
      `Blocked: the provider fee is ${verified.appFeeBps / 100}%, over your ${request.maximumFeeBps / 100}% fee limit.`,
    );
  }
  const deposit = z
    .object({ quote: z.object({ depositAddress: z.string().min(2).max(64), deadline: z.iso.datetime() }) })
    .parse(providerQuote).quote;
  const quote: WalletSwapQuote = walletSwapQuoteSchema.parse({
    request,
    accountId,
    depositAddress: deposit.depositAddress,
    input,
    output,
    inputUnits: verified.inputUnits,
    outputUnits: verified.outputUnits,
    minimumOutputUnits: verified.minOutputUnits,
    appFeeBps: verified.appFeeBps,
    quoteHash: executionHash(providerQuote),
  });
  const created = Date.now();
  const expiresAt = Math.min(Date.parse(deposit.deadline), now + QUOTE_LIFETIME_MS) - SIGNING_MARGIN_MS;
  if (expiresAt <= created) {
    throw new ExecutionError("not_ready", "1Click returned a quote that expires too soon. Try again.");
  }
  const [row] = await db
    .insert(walletSwaps)
    .values({
      id: request.requestId,
      userId,
      accountId,
      quoteJson: JSON.stringify(quote),
      depositAddress: quote.depositAddress,
      state: "quoted",
      expiresAt,
      createdAt: created,
      updatedAt: created,
    })
    .onConflictDoNothing()
    .returning();
  return view(row ?? (await ownedSwap(db, userId, request.requestId)));
}

/** Marks the swap as being signed. Only an open, unexpired quote can go to the wallet. */
export async function beginWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletSwapView> {
  const { id } = walletSwapIdSchema.parse(raw);
  const now = Date.now();
  const [row] = await db
    .update(walletSwaps)
    .set({ state: "signing", updatedAt: now })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, id),
        inArray(walletSwaps.state, ["quoted", "signing"]),
      ),
    )
    .returning();
  if (!row || now >= row.expiresAt) {
    throw new ExecutionError("conflict", "This quote expired or was already sent. Refresh the quote.");
  }
  return view(row, now);
}

/**
 * Records the wallet's transaction after checking its final receipt matches the reviewed swap exactly, then
 * tells 1Click about the deposit. 1Click also watches the address itself, so that notice only speeds it up.
 */
export async function submitWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<WalletSwapView> {
  const input = walletSwapProofSchema.parse(raw);
  const saved = await ownedSwap(db, userId, input.id);
  if (saved.transactionHash !== null) {
    if (saved.transactionHash !== input.transactionHash) {
      throw new ExecutionError("conflict", "This swap already belongs to another wallet transaction.");
    }
    return view(saved);
  }
  const quote = walletSwapQuoteSchema.parse(JSON.parse(saved.quoteJson));
  verifyWalletSwapTransaction(
    await readFinalTransaction(input.transactionHash, quote.accountId),
    quote,
    input.transactionHash,
  );
  const now = Date.now();
  const [row] = await db
    .update(walletSwaps)
    .set({ state: "submitted", transactionHash: input.transactionHash, updatedAt: now })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, input.id),
        inArray(walletSwaps.state, ["quoted", "signing"]),
      ),
    )
    .returning();
  if (!row) {
    return view(await ownedSwap(db, userId, input.id));
  }
  try {
    await oneClickJson("/v0/deposit/submit", {
      txHash: input.transactionHash,
      depositAddress: quote.depositAddress,
    });
  } catch (error) {
    reportUnexpectedError("trading", error);
  }
  return view(row);
}

/** The saved swap; a submitted one is refreshed from 1Click's status for its deposit address. */
export async function readWalletSwap(db: AppDatabase, userId: string, raw: unknown): Promise<WalletSwapView> {
  const { id } = walletSwapIdSchema.parse(raw);
  const row = await ownedSwap(db, userId, id);
  if (row.state !== "submitted") {
    return view(row);
  }
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(row.depositAddress));
  const terminal =
    status.status === "SUCCESS"
      ? "settled"
      : status.status === "REFUNDED"
        ? "refunded"
        : status.status === "FAILED"
          ? "failed"
          : null;
  if (terminal === null) {
    return view(row);
  }
  const received = terminal === "settled" ? (status.swapDetails.amountOut ?? null) : null;
  const [updated] = await db
    .update(walletSwaps)
    .set({ state: terminal, receivedUnits: received, updatedAt: Date.now() })
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, id), eq(walletSwaps.state, "submitted")))
    .returning();
  return view(updated ?? (await ownedSwap(db, userId, id)));
}

/** Drops an unsigned quote. A signed swap can't be dismissed; its funds are already with 1Click. */
export async function cancelWalletSwap(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const { id } = walletSwapIdSchema.parse(raw);
  await db
    .update(walletSwaps)
    .set({ state: "cancelled", updatedAt: Date.now() })
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, id), eq(walletSwaps.state, "quoted")));
}
