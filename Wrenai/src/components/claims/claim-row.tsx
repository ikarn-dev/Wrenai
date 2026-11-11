"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, HandCoins, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { memo, type ReactElement, type ReactNode, useState } from "react";
import { CELL } from "@/components/activity/row";
import { AgentAvatar } from "@/components/agents/avatar";
import { postTrading, readTrading } from "@/components/trading/trading-api";
import { Badge } from "@/components/ui/badge";
import { ElapsedBadge } from "@/components/ui/elapsed-badge";
import { CLAIMING_REASON, PENDING_CLAIMS_KEY, type ClaimRow as Row, WNEAR_ASSET_ID } from "@/shared/claims";
import { type ManualPreview, manualPreviewSchema } from "@/shared/manual-trading";
import { PORTFOLIO_WALLET_KEY } from "@/shared/portfolio-wallet";
import { Amounts, BadgeButton, PnlBadge, TransactionLink, Usd } from "./claim-cells";
import { type ClaimFlow, useClaimsStore } from "./flow-store";
import { unwrapNear } from "./unwrap";

export const STICKY = "sticky left-0 z-10 bg-bg";
const ROW = "border-t border-line-card align-middle text-small";
const IN_FLIGHT: ReadonlySet<ManualPreview["status"]> = new Set([
  "reserved",
  "submitting",
  "submitted",
  "unknown",
]);
const STATUS_WORDS = {
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  error: "Needs attention",
} as const;

/** The wallet unwrap of wNEAR to native NEAR, with its own progress and a neutral wallet "no". */
function useUnwrap(accountId: string) {
  const cache = useQueryClient();
  const [since, setSince] = useState(0);
  const mutation = useMutation({
    mutationFn: (units: string) => unwrapNear(accountId, units),
    onMutate: () => setSince(Date.now()),
    onSuccess: (result) =>
      result.kind === "claimed"
        ? Promise.all([
            cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY }),
            cache.invalidateQueries({ queryKey: PORTFOLIO_WALLET_KEY }),
          ])
        : undefined,
  });
  return { mutation, since };
}

function Cells({
  row,
  source,
  status,
  action,
  note,
}: {
  readonly row: Row;
  readonly source: ReactNode;
  readonly status: ReactNode;
  readonly action: ReactNode;
  readonly note?: ReactNode;
}): ReactElement {
  return (
    <tr className={ROW}>
      <td className={`${CELL} ${STICKY} max-w-60`}>{source}</td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <span className="flex flex-col items-center gap-0.5">
          <Amounts amounts={row.deposited} />
          <Usd microUsd={row.depositedMicroUsd} />
        </span>
      </td>
      <td className={`${CELL} whitespace-nowrap text-center`}>
        {row.source === "agent" && row.claimable.length > 0 ? (
          <PnlBadge pnlMicroUsd={row.pnlMicroUsd} principalMicroUsd={row.principalMicroUsd} />
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <span className="flex flex-col items-center gap-0.5">
          <Amounts amounts={row.claimable} />
          <Usd microUsd={row.claimableMicroUsd} />
        </span>
      </td>
      <td className={`${CELL} whitespace-nowrap text-center`}>{status}</td>
      <td className={`${CELL} whitespace-nowrap text-right`}>
        <span className="flex flex-col items-end gap-1">
          {action}
          {note}
        </span>
      </td>
    </tr>
  );
}

function Name({ row }: { readonly row: Row }): ReactElement {
  if (row.agent) {
    return (
      <span className="flex min-w-0 items-center gap-2.5">
        <AgentAvatar running={row.agent.status === "running"} size={24} />
        <Link
          href={`/agents/${row.agent.id}`}
          className="truncate font-medium text-fg-strong hover:underline"
        >
          {row.agent.name}
        </Link>
      </span>
    );
  }
  return (
    <span className="font-medium text-fg-strong">
      {row.source === "wallet" ? "Wallet" : "Private balance"}
    </span>
  );
}

function Note({
  children,
  alert = false,
}: {
  readonly children: string;
  readonly alert?: boolean;
}): ReactElement {
  return (
    <span
      role={alert ? "alert" : "status"}
      title={children}
      className={`max-w-56 truncate text-caption ${alert ? "text-warn" : "text-fg-muted"}`}
    >
      {children}
    </span>
  );
}

function AgentRow({ row }: { readonly row: Row }): ReactElement {
  const store = useClaimsStore();
  const agent = row.agent;
  if (!agent) {
    throw new Error("An agent row needs its agent.");
  }
  const open = () => store.selected.set(row);
  const status =
    agent.claimingSince !== null ? (
      <ElapsedBadge label="Claiming" since={agent.claimingSince} />
    ) : agent.openPosition ? (
      <Badge tone="warn" dot>
        Open position
      </Badge>
    ) : agent.deleted ? (
      <Badge tone="neutral" dot>
        Deleted
      </Badge>
    ) : agent.status === "running" || agent.status === "paused" ? (
      <Badge tone={agent.status === "running" ? "accent" : "neutral"} dot>
        {STATUS_WORDS[agent.status]}
      </Badge>
    ) : (
      <Badge tone={agent.status === "error" ? "warn" : "neutral"} dot>
        {STATUS_WORDS[agent.status]}
      </Badge>
    );
  const action =
    agent.claimingSince !== null ? (
      <BadgeButton tone="neutral" icon={RefreshCw} onClick={open}>
        Change token
      </BadgeButton>
    ) : agent.openPosition ? null : (
      <BadgeButton tone="accent" icon={HandCoins} onClick={open}>
        Claim
      </BadgeButton>
    );
  return (
    <Cells
      row={row}
      source={<Name row={row} />}
      status={status}
      action={action}
      note={
        agent.claimingSince !== null && agent.reason !== CLAIMING_REASON ? (
          <Note alert>{agent.reason}</Note>
        ) : agent.openPosition && agent.claimingSince === null ? (
          <Note>Close the position first</Note>
        ) : null
      }
    />
  );
}

function WalletRow({ row, accountId }: { readonly row: Row; readonly accountId: string }): ReactElement {
  const { mutation, since } = useUnwrap(accountId);
  const units = row.claimable[0]?.units ?? "0";
  const result = mutation.data;
  return (
    <Cells
      row={row}
      source={<Name row={row} />}
      status={
        mutation.isPending ? (
          <ElapsedBadge label="Approve in wallet" since={since} />
        ) : result?.kind === "claimed" ? (
          <Badge tone="accent" dot>
            Claimed
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            wNEAR in wallet
          </Badge>
        )
      }
      action={
        result?.kind === "claimed" ? (
          <TransactionLink hash={result.hash} />
        ) : (
          <BadgeButton
            tone="accent"
            icon={mutation.isPending ? LoaderCircle : ArrowDownToLine}
            busy={mutation.isPending}
            onClick={() => mutation.mutate(units)}
          >
            Claim as NEAR
          </BadgeButton>
        )
      }
      note={
        mutation.error ? (
          <Note alert>{mutation.error.message}</Note>
        ) : result?.kind === "cancelled" ? (
          <Note>Cancelled in your wallet</Note>
        ) : null
      }
    />
  );
}

function PrivateRow({ row }: { readonly row: Row }): ReactElement {
  const store = useClaimsStore();
  return (
    <Cells
      row={row}
      source={<Name row={row} />}
      status={
        <Badge tone="neutral" dot>
          Free
        </Badge>
      }
      action={
        <BadgeButton tone="accent" icon={HandCoins} onClick={() => store.selected.set(row)}>
          Claim
        </BadgeButton>
      }
    />
  );
}

/** One claim the server lists. Rows are memoized on the query's shared data, so a poll repaints only changes. */
export const ClaimRow = memo(function ClaimRow({
  row,
  accountId,
}: {
  readonly row: Row;
  readonly accountId: string;
}): ReactElement {
  switch (row.source) {
    case "agent":
      return <AgentRow row={row} />;
    case "wallet":
      return <WalletRow row={row} accountId={accountId} />;
    case "private":
      return <PrivateRow row={row} />;
    default: {
      const unhandled: never = row.source;
      throw new Error(`Unhandled claim source: ${String(unhandled)}`);
    }
  }
});

/** A confirmed private claim, followed through payout and, when the owner chose NEAR, the wallet unwrap. */
export const FlowRow = memo(function FlowRow({
  flow,
  accountId,
}: {
  readonly flow: ClaimFlow;
  readonly accountId: string;
}): ReactElement {
  const cache = useQueryClient();
  const { mutation, since } = useUnwrap(accountId);
  const check = useMutation({
    mutationFn: async (): Promise<ManualPreview> => {
      const result = await postTrading(
        "/api/claims/order",
        {
          step: "check",
          input: {
            id: flow.order.id,
            revision: flow.order.revision,
            bindingHash: flow.order.bindingHash,
          },
        },
        manualPreviewSchema,
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    onSuccess: async (next) => {
      // Publish the row first. A slow Claims refresh must never hold the visible terminal state.
      cache.setQueryData(["manual-order", flow.order.id], next);
      if (!IN_FLIGHT.has(next.status)) {
        await cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY });
      }
    },
  });
  const order = useQuery({
    queryKey: ["manual-order", flow.order.id],
    queryFn: ({ signal }) =>
      readTrading(`/api/trading/orders/${encodeURIComponent(flow.order.id)}`, manualPreviewSchema, signal),
    initialData: flow.order,
    refetchInterval: (query) => (IN_FLIGHT.has(query.state.data?.status ?? "reserved") ? 2000 : false),
    retry: false,
  });
  const current = order.data;
  const unwrapped = mutation.data?.kind === "claimed" ? mutation.data.hash : null;
  const payoutHash = current.transactionHash ?? null;
  const toUnwrap =
    flow.unwrap && current.status === "settled" && current.output?.assetId === WNEAR_ASSET_ID && !unwrapped
      ? (current.execution?.receivedUnits ?? null)
      : null;
  let status: ReactNode;
  if (IN_FLIGHT.has(current.status)) {
    status = <ElapsedBadge label="Claiming" since={flow.confirmedAt} />;
  } else if (current.status === "refunded") {
    status = <Badge tone="neutral">Refunded</Badge>;
  } else if (current.status !== "settled") {
    status = <Badge tone="warn">Not sent</Badge>;
  } else if (mutation.isPending) {
    status = <ElapsedBadge label="Approve in wallet" since={since} />;
  } else {
    status = (
      <Badge tone="accent" dot>
        {toUnwrap ? "wNEAR in wallet" : "Claimed"}
      </Badge>
    );
  }
  const action = IN_FLIGHT.has(current.status) ? (
    <BadgeButton
      tone="neutral"
      icon={check.isPending ? LoaderCircle : RefreshCw}
      busy={check.isPending}
      onClick={() => check.mutate()}
    >
      Check status
    </BadgeButton>
  ) : toUnwrap && toUnwrap !== "0" ? (
    <BadgeButton
      tone="accent"
      icon={mutation.isPending ? LoaderCircle : ArrowDownToLine}
      busy={mutation.isPending}
      onClick={() => mutation.mutate(toUnwrap)}
    >
      Claim as NEAR
    </BadgeButton>
  ) : unwrapped || payoutHash ? (
    <TransactionLink hash={unwrapped ?? payoutHash ?? ""} />
  ) : null;
  return (
    <Cells
      row={flow.row}
      source={<Name row={flow.row} />}
      status={status}
      action={action}
      note={
        check.error ? (
          <Note alert>{check.error.message}</Note>
        ) : mutation.error ? (
          <Note alert>{mutation.error.message}</Note>
        ) : mutation.data?.kind === "cancelled" ? (
          <Note>Cancelled in your wallet</Note>
        ) : current.status === "refunded" ? (
          <Note>Back in your private balance</Note>
        ) : null
      }
    />
  );
});
