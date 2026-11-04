"use server";
import { start } from "workflow/api";
import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { reportUnexpectedError } from "@/server/http/unexpected-error";
import { ensureManualTradingAccount } from "@/server/trading-accounts/agent-account";
import {
  beginWalletSwap,
  cancelWalletSwap,
  prepareWalletSwap,
  readWalletSwap,
  submitWalletSwap,
} from "@/server/wallet-swap/service";
import type { ManualPreview, TradingResult } from "@/shared/manual-trading";
import type { ManualAccountView, PerpsMarketRow, SpotMarketToken, TokenIcons } from "@/shared/market-pages";
import type { WalletSwapView } from "@/shared/wallet-swap";
import { runManualTrade } from "@/workflows/manual-trading";
import { type MarketChartData, marketChart } from "./chart";
import { manualAccountView, perpsMarketRows, spotMarketTokens } from "./markets";
import { confirmManualTrade, dismissManualTrade, quoteManualTrade, readManualPreview } from "./service";
import { manualSubject } from "./subject";
import { resolveChatQuote } from "./token-hints";
import { spotTokenIcons } from "./token-icons";

async function tradingAction<T>(run: (userId: string) => Promise<T>): Promise<TradingResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in before trading." };
  }
  const limit = await consumeRateLimit(`manual-trade:${user.id}`, 60, 60_000);
  if (limit !== "allowed") {
    return {
      ok: false,
      code: "rate_limited",
      message: "Too many trading requests. Wait a moment and retry.",
    };
  }
  try {
    return { ok: true, value: await run(user.id) };
  } catch (error) {
    if (error instanceof ExecutionError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "invalid_input",
        message: error.issues[0]?.message ?? "Check the trade details.",
      };
    }
    reportUnexpectedError("trading", error);
    return {
      ok: false,
      code: "unavailable",
      message: "Trading is temporarily unavailable. Check the order status before retrying.",
    };
  }
}
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
export async function readManualOrder(raw: unknown): Promise<TradingResult<ManualPreview>> {
  return tradingAction((userId) => readManualPreview(database(), userId, z.uuid().parse(raw)));
}
export async function dismissManualOrder(raw: unknown): Promise<TradingResult<null>> {
  return tradingAction(async (userId) => {
    await dismissManualTrade(database(), userId, raw);
    return null;
  });
}

export async function getSpotMarkets(): Promise<TradingResult<readonly SpotMarketToken[]>> {
  return tradingAction(() => spotMarketTokens());
}
export async function getSpotTokenIcons(): Promise<TradingResult<TokenIcons>> {
  return tradingAction(() => spotTokenIcons());
}
export async function getPerpsMarkets(): Promise<TradingResult<readonly PerpsMarketRow[]>> {
  return tradingAction(() => perpsMarketRows());
}
export async function getManualAccount(): Promise<TradingResult<ManualAccountView>> {
  return tradingAction((userId) => manualAccountView(database(), userId));
}
export async function prepareManualAccount(): Promise<TradingResult<string>> {
  return tradingAction(async (userId) => {
    const subjectId = await manualSubject(database(), userId);
    return (await ensureManualTradingAccount(database(), userId, subjectId)).perpAddress;
  });
}

export async function getMarketChart(raw: unknown): Promise<TradingResult<MarketChartData>> {
  return tradingAction(() =>
    marketChart(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,40}$/)
        .parse(raw),
    ),
  );
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
export async function readWalletSwapStatus(raw: unknown): Promise<TradingResult<WalletSwapView>> {
  return tradingAction((userId) => readWalletSwap(database(), userId, raw));
}
export async function dismissWalletSwap(raw: unknown): Promise<TradingResult<null>> {
  return tradingAction(async (userId) => {
    await cancelWalletSwap(database(), userId, raw);
    return null;
  });
}
