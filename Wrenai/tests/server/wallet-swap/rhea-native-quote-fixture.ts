import { vi } from "vitest";
import type { ChatCipher } from "@/server/chat/cipher";
import { claimChatTurn, finishChatTurn } from "@/server/chat/turns";
import type { AppDatabase } from "@/server/db/client";
import { callViewFunction, readContractCodeHash } from "@/server/near/rpc";
import {
  WALLET_SWAP_RHEA_DCL,
  WALLET_SWAP_RHEA_POOL,
  WALLET_SWAP_RHEA_WRAP,
  WALLET_SWAP_USDC,
} from "@/shared/wallet-swap";

export async function walletSwapChatInput(db: AppDatabase, cipher: ChatCipher, resume: boolean) {
  const input = {
    requestId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    previousTurnId: null,
    includeContext: true,
    message: "swap all usdc to near",
  };
  if (!resume) {
    return input;
  }
  const claim = await claimChatTurn(db, "owner", input, { cipher });
  if (claim.kind !== "claimed") {
    throw new Error("Expected a new chat turn");
  }
  const text =
    "Which balance should I use for all USDC: the connected NEAR wallet or the confidential/private balance?";
  await finishChatTurn(
    db,
    "owner",
    input,
    claim.token,
    {
      state: "complete",
      receipt: null,
      reply: {
        content: text,
        receipt: null,
        context: null,
        historyTrimmed: false,
        manual: { text, tradeIds: [] },
      },
    },
    cipher,
  );
  return {
    ...input,
    requestId: crypto.randomUUID(),
    previousTurnId: input.requestId,
    message: "the connected near wallet",
  };
}

export function mockRheaQuote(): void {
  const blockHash = "6".repeat(44);
  vi.mocked(callViewFunction).mockImplementation(async (_contract, method) => {
    if (method === "get_pool") {
      return {
        value: {
          pool_id: WALLET_SWAP_RHEA_POOL,
          token_x: WALLET_SWAP_USDC.slice("nep141:".length),
          token_y: WALLET_SWAP_RHEA_WRAP,
          state: "Running",
          total_liquidity: "1",
          tax: null,
          whitelist: null,
        },
        blockHeight: 1,
        blockHash,
      };
    }
    if (method === "quote") {
      return {
        value: { amount: "25000000000000000000000" },
        blockHeight: 1,
        blockHash,
      };
    }
    return { value: { min: "1250000000000000000000" }, blockHeight: 1, blockHash };
  });
  const hashes: Readonly<Record<string, string>> = {
    [WALLET_SWAP_RHEA_DCL]: "3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo",
    [WALLET_SWAP_RHEA_WRAP]: "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1",
    [WALLET_SWAP_USDC.slice("nep141:".length)]: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q",
  };
  vi.mocked(readContractCodeHash).mockImplementation(async (account) => ({
    codeHash: hashes[account] ?? "wrong",
    globalCodeHash: null,
    globalCodeAccount: null,
    blockHash,
  }));
}
