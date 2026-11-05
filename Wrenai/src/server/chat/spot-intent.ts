import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { manualAvailableUnits } from "@/server/manual-trading/balances";
import { quoteManualTrade } from "@/server/manual-trading/service";
import { manualSubject } from "@/server/manual-trading/subject";
import {
  exactToken,
  explicitTokenIds,
  NATIVE_NEAR,
  NATIVE_NEAR_OUTPUT_UNAVAILABLE,
} from "@/server/manual-trading/token-identity";
import { intentTokens } from "@/server/research/intents";
import { prepareWalletSwap } from "@/server/wallet-swap/service";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { ChatInput } from "@/shared/chat";
import {
  hasRelativeTradeSize,
  isManualTradeRequest,
  isNativePayoutPair,
  parseExactSpotQuote,
  parseWalletBalanceQuote,
} from "@/shared/chat-quote";
import { tradeSizeSchema, tradeSizeUnits } from "@/shared/trade-size";
import type { WalletSwapView } from "@/shared/wallet-swap";
import { WALLET_SWAP_USDC } from "@/shared/wallet-swap";

const spotIntent = z.strictObject({
  kind: z.literal("spot"),
  inputAssetId: z.string().trim().min(1).max(180),
  outputAssetId: z.string().trim().min(1).max(180),
  amount: tradeSizeSchema,
  balance: z.enum(["wallet", "confidential", "native_near"]).nullable().optional(),
  slippageBps: z.number().int().min(1).max(500),
  maximumFeeBps: z.number().int().min(0).max(2000),
});

async function privateAmount(
  db: AppDatabase,
  userId: string,
  assetId: string,
  decimals: number,
  size: Exclude<z.infer<typeof tradeSizeSchema>, string>,
): Promise<string> {
  const [subjectId] = await Promise.all([manualSubject(db, userId), synchronizePrivateInventory(db, userId)]);
  const available = await manualAvailableUnits(db, userId, subjectId, "confidential", assetId, Date.now());
  let units: bigint;
  try {
    units = tradeSizeUnits(size, decimals, available);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ExecutionError("limit", error.message);
    }
    throw error;
  }
  if (units <= 0n) {
    throw new ExecutionError(
      "insufficient_funds",
      "No spendable amount matches that request in your private balance.",
    );
  }
  return budgetTokenAmount(units.toString(), decimals);
}

export async function prepareChatSpot(
  db: AppDatabase,
  user: SessionUser,
  input: ChatInput,
  raw: unknown,
  signal: AbortSignal,
  previousMessage?: string,
): Promise<{ walletSwap: WalletSwapView } | { tradeId: string }> {
  const spot = spotIntent.parse(raw);
  const relative = typeof spot.amount !== "string";
  if (!relative && hasRelativeTradeSize(input.message)) {
    throw new ExecutionError("not_ready", "Which share of your available balance should I use?");
  }
  if (/\$\s*\d|\b\d[\d.]*\s*(?:usd|dollars?)\s+worth\b/i.test(input.message)) {
    throw new ExecutionError("not_ready", "Enter the amount in the token you want to spend.");
  }
  const wallet =
    /\b(?:from|in|using|out of)\s+(?:(?:my|the|a|connected|near)\s+)*wallet\b|\bmy wallet(?:['’]s)?\s+(?:balance|\w+\b)/i.test(
      input.message,
    );
  const privateBalance = /\b(?:private|confidential)\s+balance\b/i.test(input.message);
  if (wallet && privateBalance) {
    throw new ExecutionError("not_ready", "Which balance should pay for the swap, wallet or private?");
  }
  const message = input.message;
  const exact =
    parseWalletBalanceQuote(message, spot.balance === "wallet") ??
    parseExactSpotQuote(message.replace(/\s+with \d+(?:\.\d+)?% slippage[.?!]?$/i, ""));
  const pinnedPair = exact && isNativePayoutPair(exact.inputToken, exact.outputToken);
  // The reviewed RHEA route has its own exact token identities and does not use 1Click.
  const tokens = pinnedPair
    ? [{ assetId: WALLET_SWAP_USDC, blockchain: "near", symbol: "USDC", decimals: 6 }]
    : (await intentTokens(signal)).tokens;
  const inputAssetId = exactToken(tokens, spot.inputAssetId);
  const outputAssetId = exactToken(tokens, spot.outputAssetId);
  const named = explicitTokenIds(tokens, message);
  const followUp =
    previousMessage &&
    isManualTradeRequest(previousMessage) &&
    /\b(?:it|same pair|that pair|that quote|yes)\b/i.test(message);
  const requested = followUp && named.size === 0 ? explicitTokenIds(tokens, previousMessage) : named;
  if (
    !requested.has(inputAssetId) ||
    !requested.has(outputAssetId) ||
    (exact &&
      (inputAssetId !== exactToken(tokens, exact.inputToken) ||
        outputAssetId !== exactToken(tokens, exact.outputToken)))
  ) {
    throw new ExecutionError(
      "not_ready",
      "Specify the token to spend and the token to receive. Use contract IDs if a symbol is ambiguous.",
    );
  }
  if (inputAssetId === outputAssetId) {
    throw new ExecutionError("not_ready", "Choose two different tokens.");
  }
  if (outputAssetId === NATIVE_NEAR && inputAssetId !== WALLET_SWAP_USDC) {
    throw new ExecutionError("not_ready", NATIVE_NEAR_OUTPUT_UNAVAILABLE);
  }
  const native = inputAssetId === NATIVE_NEAR;
  const balance =
    (wallet ? "wallet" : privateBalance ? "confidential" : spot.balance) ??
    (native || outputAssetId === NATIVE_NEAR ? "wallet" : null);
  if (outputAssetId === NATIVE_NEAR && balance !== "wallet") {
    throw new ExecutionError("not_ready", "Choose your wallet as the source for a native NEAR swap.");
  }
  if (relative && !balance) {
    throw new ExecutionError(
      "not_ready",
      "Which balance should I use for the swap, your wallet or private balance?",
    );
  }
  if (native && balance && balance !== "wallet") {
    throw new ExecutionError("not_ready", "Native NEAR must be paid from the connected wallet.");
  }
  if (balance === "wallet") {
    const walletSwap = await prepareWalletSwap(
      db,
      user.id,
      {
        requestId: input.requestId,
        inputAssetId,
        outputAssetId,
        amount: spot.amount,
        slippageBps: spot.slippageBps,
        maximumFeeBps: spot.maximumFeeBps,
      },
      signal,
    );
    return { walletSwap };
  }
  let amount = spot.amount;
  if (typeof amount !== "string") {
    if (balance === "native_near") {
      throw new ExecutionError("not_ready", "Enter a token amount for this RHEA trading balance.");
    }
    const token = tokens.find((candidate) => candidate.assetId === inputAssetId);
    if (!token) {
      throw new ExecutionError("not_ready", "Choose an exact supported input token.");
    }
    amount = await privateAmount(db, user.id, inputAssetId, token.decimals, amount);
  }
  const preview = await quoteManualTrade(db, user.id, {
    requestId: input.requestId,
    source: "jarvis",
    intent: {
      ...spot,
      inputAssetId,
      outputAssetId,
      amount,
      balance: balance ?? "confidential",
    },
  });
  return { tradeId: preview.id };
}
