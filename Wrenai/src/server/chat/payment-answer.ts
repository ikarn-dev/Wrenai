import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import { intentTokens } from "@/server/research/intents";
import { MarketUnavailable } from "@/server/research/market-http";
import { nearAccountSchema, walletAssetSchema } from "@/shared/agent-budget";
import type { ChatTurn } from "@/shared/chat";
import type { PaymentOffer } from "@/shared/chat-payment";
import {
  type ChatPayment,
  isPaymentRetry,
  type PaymentRequest,
  parseChatPayment,
} from "@/shared/chat-payment-command";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";
import { ChatError } from "./errors";

export function retryChatPayment(
  history: readonly ChatTurn[],
  previousTurnId: string | null,
): PaymentRequest {
  const latest = history.at(-1);
  if (latest?.id === previousTurnId) {
    let sequence = latest.sequence;
    for (const turn of history.toReversed()) {
      if (turn.sequence !== sequence) {
        break;
      }
      if (turn.reply?.manual?.payment) {
        return { issue: "Use the existing payment card to review or check that payment." };
      }
      if (!isPaymentRetry(turn.message)) {
        const request = parseChatPayment(turn.message);
        if (request) {
          return request;
        }
        break;
      }
      sequence -= 1;
    }
  }
  return { issue: "What amount and token should I send, and to which account?" };
}

async function findToken(
  accountId: string,
  request: ChatPayment,
  signal: AbortSignal,
): Promise<{
  id: string;
  symbol: string;
  privateSupported: boolean;
}> {
  const hint = request.token;
  if (/^(?:near|native near|native:near)$/.test(hint)) {
    return { id: WALLET_SWAP_NATIVE_OUTPUT, symbol: "NEAR", privateSupported: false };
  }
  const wrapped = /^(?:wnear|wrapped near|wrap\.near|nep141:wrap\.near)$/.test(hint);
  const contract = nearAccountSchema.safeParse(hint.replace(/^nep141:/, ""));
  const exact = wrapped
    ? WALLET_SWAP_INPUT
    : contract.success && (hint.includes(".") || hint.startsWith("nep141:") || /^[a-f0-9]{64}$/.test(hint))
      ? `nep141:${contract.data}`
      : null;
  const [wallet, registry] = await Promise.all([
    request.route === "private"
      ? null
      : exact
        ? walletTokenHolding(accountId, exact, signal)
            .then((holding) => [holding])
            .catch((error: unknown) => {
              if (error instanceof ChatError) {
                return [];
              }
              throw error;
            })
        : walletTokenHoldings(accountId, [], signal).then((snapshot) => snapshot.tokens),
    request.route === "wallet"
      ? null
      : intentTokens(signal).catch((error: unknown) => {
          if (error instanceof MarketUnavailable || error instanceof z.ZodError) {
            return null;
          }
          throw error;
        }),
  ]);
  const matches = new Map<string, string>();
  const normalized = hint === "usd coin" ? "usdc" : hint;
  function include(id: string, symbol: string): void {
    if (!walletAssetSchema.safeParse(id).success || (id === WALLET_SWAP_INPUT && !wrapped)) {
      return;
    }
    if (exact ? id === exact : id !== WALLET_SWAP_NATIVE_OUTPUT && symbol.toLowerCase() === normalized) {
      matches.set(id, wrapped ? "wNEAR" : symbol);
    }
  }
  for (const token of wallet ?? []) {
    include(token.assetId, token.symbol);
  }
  const nearTokens = registry?.tokens.filter((token) => token.blockchain.toLowerCase() === "near") ?? [];
  for (const token of nearTokens) {
    include(token.assetId, token.symbol);
  }
  if (matches.size !== 1) {
    throw new ChatError(
      "invalid_input",
      matches.size > 1
        ? "More than one token uses that name. Enter the token contract to choose the exact one."
        : "I couldn't verify that token. Check its name or enter its NEAR token contract.",
    );
  }
  const [found] = matches;
  if (!found) {
    throw new ChatError("invalid_input", "I couldn't verify that token.");
  }
  return {
    id: found[0],
    symbol: found[1],
    privateSupported: nearTokens.some((token) => token.assetId === found[0]),
  };
}

export async function answerChatPayment(
  user: SessionUser,
  id: string,
  request: PaymentRequest,
  signal: AbortSignal,
): Promise<{
  content: string;
  receipt: null;
  reports: [];
  manual: { text: string; tradeIds: []; payment?: PaymentOffer };
}> {
  let text = "Review payment.";
  let payment: PaymentOffer | undefined;
  try {
    if ("issue" in request) {
      text = request.issue;
    } else if (request.recipient === user.accountId) {
      text = "Choose a recipient other than your connected account.";
    } else {
      const token = await findToken(user.accountId, request, signal);
      if (request.route === "private" && !token.privateSupported) {
        text =
          token.id === WALLET_SWAP_NATIVE_OUTPUT
            ? "Native NEAR can only be sent from your public wallet. Ask for a public payment if you want to use that route."
            : "This exact token is unavailable for private payments.";
      } else {
        payment = {
          id,
          recipient: request.recipient,
          assetId: token.id,
          symbol: token.symbol,
          amount: request.amount,
          routes: request.route
            ? [request.route]
            : token.privateSupported
              ? ["private", "wallet"]
              : ["wallet"],
        };
      }
    }
  } catch (error) {
    if (!(error instanceof ChatError)) {
      throw error;
    }
    text = error.message;
  }
  return {
    content: text,
    receipt: null,
    reports: [],
    manual: { text, tradeIds: [], ...(payment ? { payment } : {}) },
  };
}
