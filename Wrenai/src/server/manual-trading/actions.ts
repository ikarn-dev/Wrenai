"use server";
import { database } from "@/server/db/client";
import { ensureManualTradingAccount } from "@/server/trading-accounts/agent-account";
import type { TradingResult } from "@/shared/manual-trading";
import { manualSubject } from "./subject";
import { tradingAction } from "./trading-action";
// Quotes, confirmations and wallet swaps are POST route handlers (src/app/api/trading, called through
// components/trading/trading-mutations.ts): a Server Action holds the router while it runs.
export async function prepareManualAccount(): Promise<TradingResult<string>> {
  return tradingAction(async (userId) => {
    const subjectId = await manualSubject(database(), userId);
    return (await ensureManualTradingAccount(database(), userId, subjectId)).perpAddress;
  });
}
