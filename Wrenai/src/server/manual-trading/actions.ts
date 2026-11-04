"use server";
import { start } from "workflow/api";
import { database } from "@/server/db/client";
import { ensureManualTradingAccount } from "@/server/trading-accounts/agent-account";
import {
  beginWalletSwap,
  cancelWalletSwap,
  prepareWalletSwap,
  submitWalletSwap,
} from "@/server/wallet-swap/service";
import type { ManualPreview, TradingResult } from "@/shared/manual-trading";
import type { WalletSwapView } from "@/shared/wallet-swap";
import { runManualTrade } from "@/workflows/manual-trading";
import { confirmManualTrade, dismissManualTrade, quoteManualTrade } from "./service";
import { manualSubject } from "./subject";
import { resolveChatQuote } from "./token-hints";
import { tradingAction } from "./trading-action";

// Mutations only. Polled reads (markets, account, order and swap status) are GET routes in src/app/api/trading.

export async function requestManualQuote(raw: unknown): Promise<TradingResult<ManualPreview>> {
  return tradingAction((userId) => quoteManualTrade(database(), userId, raw));
}
export async function requestChatSpotQuote(raw: unknown): Promise<TradingResult<ManualPreview>> {
  return tradingAction(async (userId) => quoteManualTrade(database(), userId, await resolveChatQuote(raw)));
}
export async function confirmManualOrder(raw: unknown): Promise<TradingResult<ManualPreview>> {
  return tradingAction(async (userId) => {
    const result = await confirmManualTrade(database(), userId, raw);
    if (
      result.status === "reserved" ||
      result.status === "submitting" ||
      result.status === "submitted" ||
      result.status === "unknown"
    ) {
      await start(runManualTrade, [userId, result.id]);
    }
    return result;
  });
}
export async function dismissManualOrder(raw: unknown): Promise<TradingResult<null>> {
  return tradingAction(async (userId) => {
    await dismissManualTrade(database(), userId, raw);
    return null;
  });
}
export async function prepareManualAccount(): Promise<TradingResult<string>> {
  return tradingAction(async (userId) => {
    const subjectId = await manualSubject(database(), userId);
    return (await ensureManualTradingAccount(database(), userId, subjectId)).perpAddress;
  });
}

// Swaps paid from the wallet (server/wallet-swap): the wallet signs; Wrenai only quotes, verifies and tracks.
export async function requestWalletSwap(raw: unknown): Promise<TradingResult<WalletSwapView>> {
  return tradingAction((userId) => prepareWalletSwap(database(), userId, raw));
}
export async function startWalletSwap(raw: unknown): Promise<TradingResult<WalletSwapView>> {
  return tradingAction((userId) => beginWalletSwap(database(), userId, raw));
}
export async function recordWalletSwap(raw: unknown): Promise<TradingResult<WalletSwapView>> {
  return tradingAction((userId) => submitWalletSwap(database(), userId, raw));
}
export async function dismissWalletSwap(raw: unknown): Promise<TradingResult<null>> {
  return tradingAction(async (userId) => {
    await cancelWalletSwap(database(), userId, raw);
    return null;
  });
}
