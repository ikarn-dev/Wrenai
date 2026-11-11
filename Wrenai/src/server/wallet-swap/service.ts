import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { walletAllocatedUnits } from "@/server/agents/token-budgets";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { intentsStatusSchema, readIntentsProviderStatus } from "@/server/execution/intents-reconciliation";
import { oneClickJson, providerSlippageBps, verifiedProviderQuote } from "@/server/execution/oneclick-quote";
import { executionHash } from "@/server/execution/records";
import { MAX_NATIVE_GAS_UNITS } from "@/server/execution/rhea/contracts";
import { reportUnexpectedError } from "@/server/http/unexpected-error";
import { callViewFunction, readFinalTransaction } from "@/server/near/rpc";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { intentTokens } from "@/server/research/intents";
import { nearAccountSchema } from "@/shared/agent-budget";
import { tokenUnitsSchema } from "@/shared/token-units";
import { tradeAssetSchema } from "@/shared/trade-preview";
import { tradeSizeUnits } from "@/shared/trade-size";
import {
  WALLET_SWAP_INPUT,
  WALLET_SWAP_NATIVE_OUTPUT,
  WALLET_SWAP_RHEA_POOL,
  WALLET_SWAP_USDC,
  type WalletSwapQuote,
  type WalletSwapView,
  walletSwapIdSchema,
  walletSwapProofSchema,
  walletSwapQuoteSchema,
  walletSwapRequestSchema,
  walletSwapSubmissionSchema,
} from "@/shared/wallet-swap";
import { verifyPaymentTopUpStatus } from "./private-top-up";
import { verifyWalletSwapTransaction } from "./proof";
import { nativeNearAsset, quoteRheaNative, usdcAsset, verifyRheaNativeContracts } from "./rhea-native";
import { reconcileRheaNativeSwap, submitRheaNativeSwap } from "./rhea-native-lifecycle";

// The deposit must reach 1Click before its quote deadline; the card stops offering Confirm a minute earlier so a
// slow wallet approval still lands in time.
const QUOTE_LIFETIME_MS = 10 * 60_000;
const SIGNING_MARGIN_MS = 60_000;
// 1Click deposits need a gas buffer. RHEA uses the reviewed native-execution ceiling because its call attaches
// 180 Tgas and 0.01 NEAR cannot cover that at the current 100 million yoctoNEAR gas price.
const GAS_RESERVE_YOCTO = 10_000_000_000_000_000_000_000n;
const NATIVE_ASSET = "native:near";

function gasReserve(rheaNative: boolean): bigint {
  return rheaNative ? MAX_NATIVE_GAS_UNITS : GAS_RESERVE_YOCTO;
}

type Row = typeof walletSwaps.$inferSelect;

function view(row: Row, now = Date.now()): WalletSwapView {
  const quote = walletSwapQuoteSchema.parse(JSON.parse(row.quoteJson));
  return {
    id: row.id,
    state: row.state === "quoted" && (now >= row.expiresAt || !quote.pairVerified) ? "expired" : row.state,
    quote,
    transactionHash: row.transactionHash,
    receivedUnits: row.receivedUnits,
    spentUnits: row.spentUnits,
    expiresAt: row.expiresAt,
  };
}

async function walletAvailability(db: AppDatabase, userId: string, accountId: string, assetId: string) {
  const [holding, allocated] = await Promise.all([
    walletTokenHolding(accountId, assetId),
    walletAllocatedUnits(db, userId, accountId, assetId),
  ]);
  return { units: BigInt(holding.spendableUnits) - allocated, decimals: holding.decimals };
}

function requireWalletFunds(available: bigint, units: bigint, symbol: string): void {
  if (units <= 0n || units > available) {
    throw new ExecutionError(
      "insufficient_funds",
      `Not enough available ${symbol} in your wallet after gas and existing allocations.`,
    );
  }
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

/**
 * Saves a verified quote for wallet approval: a finalized RHEA pool quote or a signed 1Click quote.
 */
export async function prepareWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<WalletSwapView> {
  const request = walletSwapRequestSchema.parse(raw);
  const [owner] = await db
    .select({ accountId: users.accountId, existing: walletSwaps })
    .from(users)
    .leftJoin(walletSwaps, and(eq(walletSwaps.userId, users.id), eq(walletSwaps.id, request.requestId)))
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) {
    throw new ExecutionError("not_found", "Sign in again before swapping.");
  }
  if (owner.existing) {
    if (view(owner.existing).quote.privateTopUp) {
      throw new ExecutionError("conflict", "Review this deposit from its original payment card.");
    }
    return view(owner.existing);
  }
  const { accountId } = owner;
  const nativeOutput = request.outputAssetId === WALLET_SWAP_NATIVE_OUTPUT;
  const walletAssetId = request.inputAssetId ?? NATIVE_ASSET;
  if (nativeOutput && walletAssetId !== WALLET_SWAP_USDC) {
    throw new ExecutionError("not_ready", "Native NEAR payouts are currently available for USDC swaps.");
  }
  const native = walletAssetId === NATIVE_ASSET;
  const origin = native ? WALLET_SWAP_INPUT : walletAssetId;
  const [registry, holding, near, storage] = await Promise.all([
    nativeOutput ? null : intentTokens(signal),
    walletAvailability(db, userId, accountId, walletAssetId),
    native ? null : walletAvailability(db, userId, accountId, NATIVE_ASSET),
    native || nativeOutput
      ? null
      : callViewFunction(origin.slice(7), "storage_balance_bounds", {}, signal).then(
          ({ value }) => z.object({ min: tokenUnitsSchema }).parse(value).min,
        ),
  ]);
  const find = (assetId: string) => {
    const token = registry?.tokens.find((t) => t.assetId === assetId && t.blockchain === "near");
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
  const asset = nativeOutput ? usdcAsset() : find(origin);
  const input = native ? { ...asset, symbol: "NEAR", tokenSymbol: "NEAR" } : asset;
  const destination = nativeOutput ? nativeNearAsset : find(request.outputAssetId);
  const output =
    destination.assetId === WALLET_SWAP_INPUT
      ? { ...destination, symbol: "wNEAR", tokenSymbol: "wNEAR" }
      : destination;
  if (output.assetId === origin) {
    if (native) {
      throw new ExecutionError("not_ready", "This route cannot wrap native NEAR into wNEAR.");
    }
    throw new ExecutionError("not_ready", "Choose a different token on NEAR for this wallet swap.");
  }
  if (!native && holding.decimals !== input.decimals) {
    throw new ExecutionError("not_ready", "The wallet token decimals do not match the supported route.");
  }
  const reserve = gasReserve(nativeOutput);
  if (!nativeOutput && storage !== null && BigInt(storage) > reserve) {
    throw new ExecutionError("limit", "The token registration cost exceeds the supported limit.");
  }
  if (near) {
    requireWalletFunds(near.units, reserve + BigInt(storage ?? "0") + 1n, "NEAR for gas");
  }
  const available = holding.units - (native ? reserve : 0n);
  let units: bigint;
  try {
    units = tradeSizeUnits(request.amount, input.decimals, available);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ExecutionError("limit", error.message);
    }
    throw error;
  }
  requireWalletFunds(available, units, input.tokenSymbol);
  const now = Date.now();
  if (nativeOutput) {
    const quote = await quoteRheaNative(units.toString(), request.slippageBps, request.maximumFeeBps, signal);
    const savedQuote: WalletSwapQuote = walletSwapQuoteSchema.parse({
      request,
      accountId,
      depositAddress: null,
      depositKind: "rhea_native",
      pairVerified: true,
      rheaPoolId: WALLET_SWAP_RHEA_POOL,
      rheaBlockHash: quote.blockHash,
      input,
      output: destination,
      inputUnits: units.toString(),
      outputUnits: quote.outputUnits,
      minimumOutputUnits: quote.minimumOutputUnits,
      appFeeBps: 0,
      quoteHash: executionHash(quote),
    });
    const created = Date.now();
    const expiresAt = created + 60_000;
    const [row] = await db
      .insert(walletSwaps)
      .values({
        id: request.requestId,
        userId,
        accountId,
        quoteJson: JSON.stringify(savedQuote),
        depositAddress: null,
        state: "quoted",
        expiresAt,
        createdAt: created,
        updatedAt: created,
      })
      .onConflictDoNothing()
      .returning();
    return view(row ?? (await ownedSwap(db, userId, request.requestId)));
  }
  const quoteRequest: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: providerSlippageBps(request.slippageBps),
    originAsset: origin,
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
  const providerQuote = await oneClickJson("/v0/quote", quoteRequest, signal);
  // The scope only labels the returned record; every routing field is checked against quoteRequest above.
  const verified = verifiedProviderQuote(
    providerQuote,
    quoteRequest,
    "intents",
    Date.now(),
    request.slippageBps,
  );
  if (verified.appFeeBps > request.maximumFeeBps) {
    throw new ExecutionError(
      "limit",
      `Blocked: the provider fee is ${verified.appFeeBps / 100}%, over your ${request.maximumFeeBps / 100}% fee limit.`,
    );
  }
  const deposit = z
    .object({
      quote: z.object({
        depositAddress: z.string().min(2).max(64),
        deadline: z.iso.datetime(),
        depositMemo: z.union([z.literal(""), z.null()]).optional(),
      }),
    })
    .parse(providerQuote).quote;
  const quote: WalletSwapQuote = walletSwapQuoteSchema.parse({
    request,
    accountId,
    depositAddress: deposit.depositAddress,
    depositKind: native ? "native_near" : "nep141",
    pairVerified: true,
    ...(storage !== null ? { storageDepositUnits: storage } : {}),
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
  paymentTopUp = false,
): Promise<WalletSwapView> {
  const { id } = walletSwapIdSchema.parse(raw);
  const saved = view(await ownedSwap(db, userId, id));
  if (saved.state === "expired" && !saved.quote.pairVerified) {
    throw new ExecutionError("not_ready", "Request a new quote with the exact tokens.");
  }
  if (saved.state !== "quoted") {
    throw new ExecutionError("conflict", "This quote expired or was already sent. Refresh the quote.");
  }
  const { quote } = saved;
  if (Boolean(quote.privateTopUp) !== paymentTopUp) {
    throw new ExecutionError("conflict", "Review this deposit from its original card.");
  }
  const assetId = quote.request.inputAssetId ?? NATIVE_ASSET;
  const native = assetId === NATIVE_ASSET;
  const [asset, near] = await Promise.all([
    walletAvailability(db, userId, quote.accountId, assetId),
    native ? null : walletAvailability(db, userId, quote.accountId, NATIVE_ASSET),
    quote.depositKind === "rhea_native" ? verifyRheaNativeContracts() : null,
  ]);
  if (!native && asset.decimals !== quote.input.decimals) {
    throw new ExecutionError("not_ready", "Token decimals changed. Request a fresh quote.");
  }
  const reserve = gasReserve(quote.depositKind === "rhea_native");
  requireWalletFunds(
    asset.units,
    BigInt(quote.inputUnits) + (native ? reserve : 0n),
    quote.input.tokenSymbol,
  );
  if (near) {
    requireWalletFunds(near.units, reserve + BigInt(quote.storageDepositUnits ?? "0") + 1n, "NEAR for gas");
  }
  const now = Date.now();
  const [row] = await db
    .update(walletSwaps)
    .set({ state: "signing", updatedAt: now })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, id),
        eq(walletSwaps.state, "quoted"),
        gt(walletSwaps.expiresAt, now),
        sql`${walletSwaps.quoteJson}::jsonb ->> 'depositKind' IN ('native_near', 'nep141', 'rhea_native')`,
      ),
    )
    .returning();
  if (!row) {
    throw new ExecutionError("conflict", "This quote expired or was already sent. Refresh the quote.");
  }
  return view(row, now);
}

/**
 * Saves a RHEA hash for receipt checks, or verifies and reports a finalized 1Click deposit.
 */
export async function submitWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
  paymentTopUp = false,
): Promise<WalletSwapView> {
  const input = walletSwapSubmissionSchema.parse(raw);
  const saved = await ownedSwap(db, userId, input.id);
  const quote = view(saved).quote;
  if (Boolean(quote.privateTopUp) !== paymentTopUp) {
    throw new ExecutionError("conflict", "Verify this deposit from its original card.");
  }
  if (quote.depositKind === "rhea_native") {
    return view(await submitRheaNativeSwap(db, saved, input.transactionHash, input.fromRecovery));
  }
  if (saved.transactionHash !== null) {
    if (saved.transactionHash !== input.transactionHash) {
      throw new ExecutionError("conflict", "This swap already belongs to another wallet transaction.");
    }
    return view(saved);
  }
  if (saved.state !== "signing") {
    throw new ExecutionError("conflict", "This swap is not awaiting a wallet deposit.");
  }
  const row = await recordConfirmedDeposit(db, saved, input.transactionHash);
  try {
    await oneClickJson("/v0/deposit/submit", {
      txHash: input.transactionHash,
      depositAddress: nearAccountSchema.parse(row.depositAddress),
      nearSenderAccount: row.accountId,
    });
  } catch (error) {
    reportUnexpectedError("trading", error);
  }
  return view(row);
}

async function recordConfirmedDeposit(db: AppDatabase, saved: Row, hash: string): Promise<Row> {
  const quote = view(saved).quote;
  verifyWalletSwapTransaction(await readFinalTransaction(hash, quote.accountId), quote, hash);
  const [row] = await db
    .update(walletSwaps)
    .set({ state: "submitted", transactionHash: hash, updatedAt: Date.now() })
    .where(
      and(
        eq(walletSwaps.userId, saved.userId),
        eq(walletSwaps.id, saved.id),
        eq(walletSwaps.state, "signing"),
      ),
    )
    .returning();
  const current = row ?? (await ownedSwap(db, saved.userId, saved.id));
  if (current.transactionHash !== hash) {
    throw new ExecutionError("conflict", "This deposit does not match the active swap.");
  }
  return current;
}

/** The saved swap; submitted RHEA swaps recheck NEAR, while 1Click swaps refresh by deposit address. */
export async function readWalletSwap(
  db: AppDatabase,
  userId: string,
  raw: unknown,
  paymentTopUp = false,
): Promise<WalletSwapView> {
  const { id } = walletSwapIdSchema.parse(raw);
  let row = await ownedSwap(db, userId, id);
  const quote = view(row).quote;
  if (Boolean(quote.privateTopUp) !== paymentTopUp) {
    throw new ExecutionError("not_found", "This swap could not be found.");
  }
  if (row.state !== "submitted" && row.state !== "signing") {
    return view(row);
  }
  if (quote.depositKind === "rhea_native") {
    return view(row.state === "submitted" ? await reconcileRheaNativeSwap(db, row) : row);
  }
  const status = intentsStatusSchema.parse(
    await readIntentsProviderStatus(nearAccountSchema.parse(row.depositAddress)),
  );
  if (row.state === "signing") {
    const hashes = status.swapDetails.originChainTxHashes;
    const hash = hashes?.length === 1 ? hashes[0]?.hash : undefined;
    if (!hash) {
      return view(row);
    }
    const proof = walletSwapProofSchema.parse({ id, transactionHash: hash });
    row = await recordConfirmedDeposit(db, row, proof.transactionHash);
  }
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
  if (quote.privateTopUp && row.transactionHash) {
    verifyPaymentTopUpStatus(quote, status, row.transactionHash);
  }
  const received = terminal === "settled" ? (status.swapDetails.amountOut ?? null) : null;
  const [updated] = await db
    .update(walletSwaps)
    .set({ state: terminal, receivedUnits: received, updatedAt: Date.now() })
    .where(and(eq(walletSwaps.userId, userId), eq(walletSwaps.id, id), eq(walletSwaps.state, "submitted")))
    .returning();
  return view(updated ?? (await ownedSwap(db, userId, id)));
}

/** Only quotes that have not entered wallet approval can be dismissed. */
export async function cancelWalletSwap(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const { id } = walletSwapIdSchema.parse(raw);
  const [cancelled] = await db
    .update(walletSwaps)
    .set({ state: "cancelled", updatedAt: Date.now() })
    .where(
      and(
        eq(walletSwaps.userId, userId),
        eq(walletSwaps.id, id),
        eq(walletSwaps.state, "quoted"),
        sql`NOT (${walletSwaps.quoteJson}::jsonb ? 'privateTopUp')`,
      ),
    )
    .returning({ id: walletSwaps.id });
  if (!cancelled && (await ownedSwap(db, userId, id)).state !== "cancelled") {
    throw new ExecutionError("conflict", "Approval has already started. Check the swap status.");
  }
}
