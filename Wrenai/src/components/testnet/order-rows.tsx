"use client";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { CELL } from "@/components/activity/row";
import { columnAlign } from "@/components/activity/table";
import { BadgeButton } from "@/components/claims/claim-cells";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { shortTokenAmount } from "@/shared/money";
import { type TestnetSnapshot, testnetAsset } from "@/shared/testnet";
import { middleTruncate } from "@/shared/truncate";
import { testnetApi } from "./api";

type Order = TestnetSnapshot["orders"][number];
const COLUMNS = ["Time", "Order", "Spent", "Received", "Status", "Transaction"] as const;
const UTC = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const STATUS: Readonly<Record<string, { readonly label: string; readonly tone: BadgeTone }>> = {
  review: { label: "Quoted", tone: "neutral" },
  queued: { label: "Pending", tone: "neutral" },
  prepared: { label: "Pending", tone: "neutral" },
  submitted: { label: "Submitted", tone: "neutral" },
  settled: { label: "Settled", tone: "accent" },
  failed: { label: "Failed", tone: "loss" },
  needs_review: { label: "Needs review", tone: "warn" },
};

function Amount({
  assetId,
  units,
}: {
  readonly assetId: string;
  readonly units: string | null;
}): ReactElement {
  if (units === null) {
    return <span className="text-fg-subtle">—</span>;
  }
  const asset = testnetAsset(assetId);
  return (
    <span className="whitespace-nowrap text-fg-strong">
      {shortTokenAmount(units, asset.decimals)} <span className="text-fg-muted">{asset.symbol}</span>
    </span>
  );
}

function OrderRow({
  order,
  onChanged,
}: {
  readonly order: Order;
  readonly onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const status = STATUS[order.state] ?? { label: order.state, tone: "neutral" as const };
  const open = order.txHash !== null && !["settled", "failed"].includes(order.state);
  async function check(): Promise<void> {
    setBusy(true);
    try {
      await testnetApi({ command: "resume", id: order.id });
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The order status could not be checked.");
    } finally {
      setBusy(false);
    }
  }
  const at = order.createdAt;
  return (
    <tr className="border-t border-line-card align-middle text-small">
      <td className={`${CELL} whitespace-nowrap font-mono text-fg-muted tabular-nums`}>
        <time dateTime={new Date(at).toISOString()}>{UTC.format(at)}</time>
      </td>
      <td className={`${CELL} text-center`}>
        <span className="flex flex-col items-center gap-0.5">
          <span className="text-fg-strong">
            {order.kind === "swap"
              ? `Swap to ${order.outputAssetId ? testnetAsset(order.outputAssetId).symbol : "token"}`
              : "Payment"}
          </span>
          <span className="max-w-48 truncate text-caption text-fg-subtle" title={order.message ?? undefined}>
            {order.kind === "payment"
              ? middleTruncate(order.recipient, 10, 6)
              : order.location === "intents"
                ? "Public Intents"
                : "Wallet"}
          </span>
        </span>
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <Amount assetId={order.assetId} units={order.inputUnits} />
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        {order.outputAssetId ? (
          <Amount
            assetId={order.outputAssetId}
            units={order.state === "settled" ? order.outputUnits : null}
          />
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className={`${CELL} whitespace-nowrap text-center`}>
        <Badge tone={status.tone} dot>
          {status.label}
        </Badge>
      </td>
      <td className={`${CELL} whitespace-nowrap text-right`}>
        <span className="flex flex-col items-end gap-1">
          {order.txHash ? (
            <a
              href={`https://testnet.nearblocks.io/txns/${encodeURIComponent(order.txHash)}`}
              target="_blank"
              rel="noreferrer"
              title={order.txHash}
              className="inline-flex items-center gap-1 rounded-xs font-mono text-accent-text underline-offset-4 hover:underline"
            >
              {middleTruncate(order.txHash, 6, 4)}
              <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
            </a>
          ) : (
            <span className="text-fg-subtle">—</span>
          )}
          {open ? (
            <BadgeButton
              tone="neutral"
              icon={RefreshCw}
              busy={busy}
              onClick={() => {
                void check();
              }}
            >
              Check status
            </BadgeButton>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

/** An agent's orders as table rows, newest first, in the Activity and Claims table style. */
export function TestnetOrderRows({
  orders,
  onChanged,
}: {
  readonly orders: readonly Order[];
  readonly onChanged: () => Promise<unknown>;
}): ReactElement {
  if (orders.length === 0) {
    return <p className="card-shine rounded-lg p-card text-small text-fg-muted">No orders yet.</p>;
  }
  return (
    <div className="overflow-x-auto overscroll-x-contain border-b border-line-card">
      <table aria-label="Agent orders" className="w-full min-w-3xl table-fixed border-collapse">
        <thead>
          <tr>
            {COLUMNS.map((label, position) => (
              <th
                key={label}
                scope="col"
                className={`${CELL} py-2.5 font-mono text-eyebrow font-medium whitespace-nowrap text-fg-subtle uppercase ${columnAlign(position, COLUMNS.length)}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
