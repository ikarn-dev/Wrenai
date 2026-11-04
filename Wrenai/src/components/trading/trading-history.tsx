"use client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { getManualAccount } from "@/server/manual-trading/actions";
import type { ManualAccountView } from "@/shared/market-pages";
import { TradeCard } from "./trade-card";

export function useManualAccount(accountId: string): UseQueryResult<ManualAccountView, Error> {
  return useQuery({
    queryKey: ["manual-account", accountId],
    queryFn: async () => {
      const r = await getManualAccount();
      if (!r.ok) {
        throw new Error(r.message);
      }
      return r.value;
    },
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
}
export function TradingHistory({
  kind,
  accountId,
}: {
  readonly accountId: string;
  readonly kind: "spot" | "perps";
}): ReactElement {
  const account = useManualAccount(accountId),
    orders =
      account.data?.orders.filter(
        (o) =>
          o.intent.kind === kind &&
          o.status !== "quoted" &&
          o.status !== "expired" &&
          o.status !== "cancelled",
      ) ?? [];
  return (
    <section className="min-w-0 border-t border-line-card pt-6">
      <h2 className="text-lead font-medium">Recent trades</h2>
      {orders.length ? (
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
          {orders.map((o) => (
            <TradeCard key={o.id} id={o.id} initial={o} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-small text-fg-muted">Your confirmed trades will appear here.</p>
      )}
    </section>
  );
}
