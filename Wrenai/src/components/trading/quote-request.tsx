"use client";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { ChatQuoteRequest } from "@/shared/chat-quote";
import { TradeCard } from "./trade-card";
import { requestChatSpotQuote } from "./trading-mutations";

/**
 * A Jarvis quote request, priced once when its reply first shows. The quote is a POST to a route handler, so the
 * chat page stays responsive while it runs (a Server Action here held the router and stalled the whole screen).
 */
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
      className="flex w-full max-w-sm flex-col gap-3 card-shine rounded-lg p-3.5"
    >
      {quote.error ? (
        <>
          <p role="alert" className="text-small text-warn">
            {quote.error.message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="soft" busy={quote.isFetching} onClick={() => void quote.refetch()}>
              Retry quote
            </Button>
            <Link
              href="/spot"
              className="inline-flex min-h-10 items-center rounded-sm px-2 text-small text-accent-text hover:underline"
            >
              Open Spot
            </Link>
          </div>
        </>
      ) : (
        <p role="status" className="flex items-center gap-1.5 text-small text-fg-muted">
          <LoaderCircle
            aria-hidden="true"
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            className="shrink-0 motion-safe:animate-spin"
          />
          Getting a live quote…
        </p>
      )}
    </section>
  );
}
