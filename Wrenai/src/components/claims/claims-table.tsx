"use client";

import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { z } from "zod";
import { CELL } from "@/components/activity/row";
import { columnAlign } from "@/components/activity/table";
import { readTrading } from "@/components/trading/trading-api";
import { type ClaimsView, claimsViewSchema, PENDING_CLAIMS_KEY } from "@/shared/claims";
import { ClaimDialog } from "./claim-dialog";
import { ClaimRow, FlowRow, STICKY } from "./claim-row";
import { ClaimsContext, createClaimsStore, useClaimsStore, useStoreValue } from "./flow-store";

const COLUMNS = [
  { id: "source", label: "Agent", width: "w-1/4" },
  { id: "deposited", label: "Deposited", width: "w-1/6" },
  { id: "pnl", label: "PnL", width: "w-1/8" },
  { id: "claimable", label: "Claimable", width: "w-1/6" },
  { id: "status", label: "Status", width: "w-1/6" },
  { id: "action", label: "", width: "w-1/8" },
] as const;
const refreshSchema = z.strictObject({ refreshed: z.boolean() });

/** Pending claims from recorded state, fast enough to poll; a returning agent polls every five seconds. */
export function useClaims(): UseQueryResult<ClaimsView, Error> {
  return useQuery({
    queryKey: PENDING_CLAIMS_KEY,
    queryFn: ({ signal }) => readTrading("/api/claims", claimsViewSchema, signal),
    staleTime: 5000,
    refetchInterval: (query) =>
      query.state.data?.rows.some((row) => row.agent?.claimingSince != null) ? 5000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Re-reads the private balance in the background, then refreshes the list. The list never waits for it. */
function usePrivateRefresh(): void {
  const cache = useQueryClient();
  useQuery({
    queryKey: [...PENDING_CLAIMS_KEY, "refresh"],
    queryFn: async ({ signal }) => {
      const result = await readTrading("/api/claims?view=refresh", refreshSchema, signal);
      if (result.refreshed) {
        await cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY, exact: true });
      }
      return result;
    },
    staleTime: 30_000,
    initialData: { refreshed: false },
    initialDataUpdatedAt: Date.now(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Nothing to list: one centered block in the page's free space, no table chrome around it. */
function EmptyState({ error }: { readonly error: string | null }): ReactElement {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center gap-2 text-center">
      <HandCoins
        aria-hidden="true"
        size={20}
        strokeWidth={1.75}
        absoluteStrokeWidth
        className="text-fg-subtle"
      />
      <p role={error ? "alert" : undefined} className={`text-body ${error ? "text-warn" : "text-fg-strong"}`}>
        {error ?? "Nothing to claim"}
      </p>
      {error ? null : (
        <p className="max-w-xs text-small text-fg-muted">Funds from stopped and deleted agents wait here.</p>
      )}
    </div>
  );
}

function Table({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="overflow-x-auto overscroll-x-contain border-b border-line-card">
      <table aria-label="Pending claims" className="w-full min-w-4xl table-fixed border-collapse">
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.id} className={column.width} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((column, position) => (
              <th
                key={column.id}
                scope="col"
                className={`${CELL} py-2.5 font-mono text-eyebrow font-medium whitespace-nowrap text-fg-subtle uppercase ${columnAlign(position, COLUMNS.length)} ${position === 0 ? STICKY : ""}`}
              >
                {column.label || <span className="sr-only">Action</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Body({ accountId }: { readonly accountId: string }): ReactElement {
  const query = useClaims(),
    localFlows = useStoreValue(useClaimsStore().flows);
  if (query.isPending) {
    return (
      <Table>
        <tr>
          <td colSpan={COLUMNS.length} className={CELL}>
            <span
              role="status"
              aria-label="Loading claims"
              className="block h-10 rounded-xs bg-surface-2 motion-safe:animate-pulse"
            />
          </td>
        </tr>
      </Table>
    );
  }
  const flowMap = new Map((query.data?.recoveries ?? []).map((flow) => [flow.id, flow]));
  for (const flow of localFlows) {
    flowMap.set(flow.id, flow);
  }
  const flows = [...flowMap.values()];
  // Hide the source row while its exact confirmed action is tracked; otherwise one balance appears twice.
  const activeSources = new Set(flows.map((flow) => flow.row.id));
  // While a claim waits to unwrap its own wNEAR payout, the wallet's wNEAR row would ask for the same approval.
  const unwrapping = flows.some((flow) => flow.unwrap);
  const rows = (query.data?.rows ?? []).filter(
    (row) => !activeSources.has(row.id) && !(row.source === "wallet" && unwrapping),
  );
  if (rows.length === 0 && flows.length === 0) {
    return <EmptyState error={query.error?.message ?? null} />;
  }
  return (
    <Table>
      {rows.map((row) => (
        <ClaimRow key={row.id} row={row} accountId={accountId} />
      ))}
      {flows.map((flow) => (
        <FlowRow key={flow.id} flow={flow} accountId={accountId} />
      ))}
    </Table>
  );
}

function Notice(): ReactElement | null {
  const notice = useClaims().data?.notice ?? null;
  return notice ? <p className="text-small text-warn">{notice}</p> : null;
}

function Dialog(): ReactElement {
  const options = useClaims().data?.receiveOptions ?? [];
  return <ClaimDialog options={options} />;
}

export function ClaimsTable({ accountId }: { readonly accountId: string }): ReactElement {
  const [store] = useState(createClaimsStore);
  usePrivateRefresh();
  return (
    <ClaimsContext.Provider value={store}>
      <div className="flex min-w-0 flex-col gap-4">
        <Notice />
        <Body accountId={accountId} />
        <Dialog />
      </div>
    </ClaimsContext.Provider>
  );
}
