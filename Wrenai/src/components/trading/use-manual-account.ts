"use client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { type ManualAccountView, manualAccountViewSchema } from "@/shared/market-pages";
import { readTrading } from "./trading-api";

/** The manual trading account: balances, Perps positions and recent orders, refreshed every 30 s. */
export function useManualAccount(accountId: string): UseQueryResult<ManualAccountView, Error> {
  return useQuery({
    queryKey: ["manual-account", accountId],
    queryFn: ({ signal }) => readTrading("/api/trading/account", manualAccountViewSchema, signal),
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
}
