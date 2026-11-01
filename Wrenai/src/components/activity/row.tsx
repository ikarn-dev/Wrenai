import {
  ArrowDownLeft,
  ArrowUpRight,
  CircleAlert,
  History,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import type { ActivityEntry } from "@/shared/activity";
import { formatActivityAmount } from "@/shared/activity-format";

const icons = {
  wallet: Wallet,
  agent: Waypoints,
  trade: History,
  funding: Wallet,
  settings: SlidersHorizontal,
  security: ShieldCheck,
} as const;
const labels = {
  completed: "Completed",
  pending: "Pending",
  failed: "Failed",
  recorded: "Recorded",
  cancelled: "Cancelled",
  refunded: "Refunded",
} as const;
const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export function ActivityRow({ item }: { readonly item: ActivityEntry }): ReactElement {
  const direction = item.amount?.kind === "token" ? item.amount.direction : "none";
  const Icon =
    item.status === "failed"
      ? CircleAlert
      : direction === "in"
        ? ArrowDownLeft
        : direction === "out"
          ? ArrowUpRight
          : icons[item.category];
  const amount = item.amount ? formatActivityAmount(item.amount) : null;
  const tone =
    item.status === "failed" ? "text-loss" : item.status === "pending" ? "text-warn" : "text-fg-muted";
  return (
    <li className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-4 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(7rem,auto)]">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-xs bg-surface-2 text-fg-muted"
      >
        <Icon size={16} strokeWidth={1.5} absoluteStrokeWidth />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium text-fg-strong">{item.title}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-subtle">
          {item.agent ? (
            item.agent.deleted ? (
              <span>{item.agent.name} · Deleted agent</span>
            ) : (
              <Link
                href={`/agents/${item.agent.id}`}
                prefetch={false}
                className="text-fg-muted hover:text-fg-strong"
              >
                {item.agent.name}
              </Link>
            )
          ) : (
            <span>{item.source === "wallet" ? "NEAR wallet" : "Account"}</span>
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(item.occurredAt).toISOString()}>
            {date.format(item.occurredAt)} · {time.format(item.occurredAt)} UTC
          </time>
          {item.transactionHash ? (
            <a
              href={`https://nearblocks.io/txns/${item.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-6 items-center gap-1 text-fg-muted hover:text-fg-strong"
              aria-label={`View transaction for ${item.title} on NearBlocks`}
            >
              View transaction <ArrowUpRight aria-hidden="true" size={12} />
            </a>
          ) : null}
        </div>
        {item.description ? (
          <p className="break-words text-caption text-fg-subtle [overflow-wrap:anywhere]">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="col-start-2 flex min-w-0 items-center justify-between gap-3 sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end sm:justify-start sm:gap-1">
        {amount ? (
          <span
            title={amount.full}
            className="break-words font-mono text-small tabular-nums text-fg-strong [overflow-wrap:anywhere] sm:text-right"
          >
            <span aria-hidden="true">{amount.display}</span>
            <span className="sr-only">{amount.full}</span>
          </span>
        ) : null}
        <span className={`inline-flex items-center gap-1.5 text-caption ${tone}`}>
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${item.status === "pending" ? "bg-warn" : item.status === "failed" ? "bg-loss" : "bg-fg-subtle"}`}
          />
          {labels[item.status]}
        </span>
      </div>
    </li>
  );
}
