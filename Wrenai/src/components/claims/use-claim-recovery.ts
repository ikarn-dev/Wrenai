"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { postTrading } from "@/components/trading/trading-api";
import { PENDING_CLAIMS_KEY } from "@/shared/claims";

const RECOVERY_KEY = [...PENDING_CLAIMS_KEY, "recover"] as const;
const recoverySchema = z.strictObject({
  resolved: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
});
type Recovery = z.infer<typeof recoverySchema>;

/**
 * While a claim may still be in flight, asks the server to reconcile confirmed claims whose workflow stopped after
 * the payout landed (reconciliation-only: nothing is signed). Calls `onSettled` when a claim finishes, whether this
 * check or the workflow finished it, so the caller can refresh without a page reload.
 */
export function useClaimRecovery(enabled: boolean, onSettled: () => void): void {
  const cache = useQueryClient();
  useQuery({
    queryKey: RECOVERY_KEY,
    queryFn: async (): Promise<Recovery> => {
      const previous = cache.getQueryData<Recovery>(RECOVERY_KEY);
      const result = await postTrading("/api/claims/order", { step: "recover" }, recoverySchema);
      if (!result.ok) {
        throw new Error(result.message);
      }
      const { resolved, inFlight } = result.value;
      // The first check also refreshes when nothing is in flight: the page may predate a claim that settled since.
      if (resolved > 0 || (previous === undefined ? inFlight === 0 : inFlight < previous.inFlight)) {
        await cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY, exact: true });
        onSettled();
      }
      return result.value;
    },
    enabled,
    staleTime: 10_000,
    refetchInterval: (query) => ((query.state.data?.inFlight ?? 0) > 0 ? 10_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
