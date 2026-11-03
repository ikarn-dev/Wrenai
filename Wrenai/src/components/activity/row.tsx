import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Braces,
  BrainCircuit,
  Coins,
  type LucideIcon,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import type { ActivityEntry } from "@/shared/activity";
import { formatActivityAmount } from "@/shared/activity-format";
import { middleTruncate } from "@/shared/truncate";
import { ActivityStatusBadge } from "./status-badge";

const ICON = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

const CATEGORY_ICONS: Readonly<Record<ActivityEntry["category"], LucideIcon>> = {
  wallet: Wallet,
  agent: BrainCircuit,
  trade: ArrowLeftRight,
  funding: Coins,
  settings: SlidersHorizontal,
  security: ShieldCheck,
};

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Shared by the header and the skeleton, so columns line up. The first column stays put while the table scrolls
 * sideways on narrow screens (Docs/DESIGN.md → Responsiveness → Tables). */
export const CELL = "px-3 py-3 first:pl-card last:pr-card";
export const STICKY_CELL =
  "sticky left-0 z-10 bg-surface-card transition-colors duration-200 ease-ios group-hover:bg-surface-2";

function rowIcon(item: ActivityEntry): { readonly Icon: LucideIcon; readonly tone: string } {
  const direction = item.amount?.kind === "token" ? item.amount.direction : "none";
  if (direction === "in") {
    return { Icon: ArrowDownLeft, tone: "text-gain" };
  }
  if (direction === "out") {
    return { Icon: ArrowUpRight, tone: "text-fg-muted" };
  }
  // "Contract call" is the wallet indexer's title for a function call (server/activity/wallet.ts).
  return {
    Icon: item.title === "Contract call" ? Braces : CATEGORY_ICONS[item.category],
    tone: "text-fg-muted",
  };
}

/**
 * Wallet details arrive as "To bob.near · method" or "From x.near · contract · #id": the direction word stays
 * plain, the account is mono, and each method or contract becomes a small code chip, like an indexer's
 * instruction column. App events are sentences and stay as text.
 */
function Details({ item }: { readonly item: ActivityEntry }): ReactNode {
  if (item.description === "") {
    return <span className="text-fg-subtle">—</span>;
  }
  if (item.source !== "wallet") {
    return <span className="line-clamp-2 text-fg-muted">{item.description}</span>;
  }
  const [head = "", ...rest] = item.description.split(" · ");
  const match = /^(To|From) (\S+)$/.exec(head);
  // Deduplicated, so each chip's text is its stable key.
  const chips = Array.from(new Set(match ? rest : [head, ...rest]));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {match ? (
        <span className="min-w-0 truncate">
          <span className="text-fg-subtle">{match[1]} </span>
          <span className="font-mono text-fg">{match[2]}</span>
        </span>
      ) : null}
      {chips.map((chip) => (
        <code
          key={chip}
          className="max-w-48 truncate rounded-xs bg-sunken px-1.5 py-0.5 font-mono text-caption text-fg-muted ring-1 ring-line-card ring-inset"
        >
          {chip}
        </code>
      ))}
    </span>
  );
}

function Origin({ item }: { readonly item: ActivityEntry }): ReactElement {
  if (item.agent === null) {
    return <span className="text-fg-muted">{item.source === "wallet" ? "NEAR wallet" : "Account"}</span>;
  }
  if (item.agent.deleted) {
    return (
      <span className="text-fg-muted">
        {item.agent.name} <span className="text-fg-subtle">· Deleted agent</span>
      </span>
    );
  }
  return (
    <Link
      href={`/agents/${item.agent.id}`}
      prefetch={false}
      className="inline-flex items-center gap-1.5 rounded-xs text-fg-muted transition-colors duration-200 ease-ios hover:text-accent-text"
    >
      <BrainCircuit {...ICON} size={14} className="shrink-0" />
      <span className="truncate">{item.agent.name}</span>
    </Link>
  );
}

function Transaction({ item }: { readonly item: ActivityEntry }): ReactElement {
  if (item.transactionHash === null) {
    return <span className="font-mono text-fg-subtle">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <a
        href={`https://nearblocks.io/txns/${item.transactionHash}`}
        target="_blank"
        rel="noopener noreferrer"
        title={item.transactionHash}
        aria-label={`View transaction for ${item.title} on NearBlocks`}
        className="rounded-xs font-mono text-accent-text underline-offset-4 hover:underline"
      >
        {middleTruncate(item.transactionHash, 6, 4)}
      </a>
      <CopyButton text={item.transactionHash} label="Copy transaction hash" />
    </span>
  );
}

/** One activity event as a table row: type, details, origin, transaction, amount, status and UTC time. */
export function ActivityRow({ item }: { readonly item: ActivityEntry }): ReactElement {
  const { Icon, tone } = rowIcon(item);
  const amount = item.amount ? formatActivityAmount(item.amount) : null;
  const incoming = item.amount?.kind === "token" && item.amount.direction === "in";
  return (
    <tr className="group border-t border-line-card align-middle text-small transition-colors duration-200 ease-ios hover:bg-surface-2">
      <td className={`${CELL} ${STICKY_CELL}`}>
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon {...ICON} className={`shrink-0 ${tone}`} />
          <span className="truncate font-medium text-fg-strong">{item.title}</span>
        </span>
      </td>
      <td className={`${CELL} max-w-80`}>
        <Details item={item} />
      </td>
      <td className={`${CELL} max-w-44 whitespace-nowrap`}>
        <Origin item={item} />
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        <Transaction item={item} />
      </td>
      <td className={`${CELL} whitespace-nowrap text-right font-mono tabular-nums`}>
        {amount ? (
          <span title={amount.full} className={incoming ? "text-gain" : "text-fg-strong"}>
            <span aria-hidden="true">{amount.display}</span>
            <span className="sr-only">{amount.full}</span>
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        <ActivityStatusBadge status={item.status} />
      </td>
      <td className={`${CELL} whitespace-nowrap text-right`}>
        <time dateTime={new Date(item.occurredAt).toISOString()} className="flex flex-col items-end">
          <span className="font-mono tabular-nums text-fg-strong">
            {TIME.format(item.occurredAt)}
            <span className="sr-only"> UTC</span>
          </span>
          <span className="text-caption text-fg-subtle">{DATE.format(item.occurredAt)}</span>
        </time>
      </td>
    </tr>
  );
}
