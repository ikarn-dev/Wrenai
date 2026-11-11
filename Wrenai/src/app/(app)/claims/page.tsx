import {
  defaultShouldDehydrateQuery,
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import type { Metadata } from "next";
import { ClaimsTable } from "@/components/claims/claims-table";
import { requireUser } from "@/server/auth/session";
import { readClaims } from "@/server/claims/pending";
import { database } from "@/server/db/client";
import { PENDING_CLAIMS_KEY } from "@/shared/claims";

export const metadata: Metadata = { title: "Claims" };

export default async function ClaimsPage() {
  const user = await requireUser();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Streams into the browser cache, so the table fills without waiting for its first poll.
  void cache.prefetchQuery({
    queryKey: PENDING_CLAIMS_KEY,
    queryFn: () => readClaims(database(), user.id, user.accountId, AbortSignal.timeout(10_000)),
  });
  const state = dehydrate(cache, {
    shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === "pending",
  });
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Claims</h1>
      <HydrationBoundary state={state}>
        <ClaimsTable accountId={user.accountId} />
      </HydrationBoundary>
    </div>
  );
}
