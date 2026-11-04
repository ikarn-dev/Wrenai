"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { requestChatSpotQuote } from "@/server/manual-trading/actions";
import type { ChatQuoteRequest } from "@/shared/chat-quote";
import { TradeCard } from "./trade-card";

export function QuoteRequest({ request }: { readonly request: ChatQuoteRequest }): ReactElement {
  const quote = useQuery({
    queryKey: ["chat-spot-quote", request.requestId],
    queryFn: async () => {
      const result = await requestChatSpotQuote(request);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (quote.data) {
    return <TradeCard id={quote.data.id} initial={quote.data} />;
  }
  return (
    <section
      aria-label="Trade quote"
      aria-busy={quote.isFetching}
      className="flex min-h-48 flex-col justify-center gap-4 rounded-lg border border-line-card bg-surface-card p-5"
    >
      <p role={quote.error ? "alert" : "status"} className="text-small text-fg-muted">
        {quote.error?.message ?? "Getting a live quote…"}
      </p>
      {quote.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={quote.isFetching}
            onClick={async () => {
              await quote.refetch();
            }}
          >
            {quote.isFetching ? "Getting quote…" : "Retry quote"}
          </Button>
          <Link
            href="/spot"
            className="inline-flex min-h-10 items-center rounded-sm px-2 text-small text-accent-text"
          >
            Open Spot
          </Link>
        </div>
      ) : null}
    </section>
  );
}
