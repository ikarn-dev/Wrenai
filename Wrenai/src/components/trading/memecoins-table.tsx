"use client";
import type { ReactElement } from "react";
import { BADGE_TONES, type BadgeTone } from "@/components/activity/status-badge";
import type { MemecoinRow } from "@/shared/market-pages";
import {
  BLOCK,
  CELL,
  Change,
  compactCount,
  compactUsd,
  HEAD,
  NUM,
  SKELETON_ROWS,
  TRADE_BUTTON,
} from "./market-cells";
import { TokenIcon } from "./token-icon";

const LAUNCHPADS: Readonly<Record<string, string>> = {
  nearly: "Nearly",
  "meme.cooking": "Meme.cooking",
  tkn: "Tkn",
};
const VERDICTS: Readonly<
  Record<NonNullable<MemecoinRow["verdict"]>, { readonly label: string; readonly tone: BadgeTone }>
> = {
  clean: { label: "Clean", tone: "success" },
  caution: { label: "Caution", tone: "warn" },
  danger: { label: "Danger", tone: "loss" },
};
const HEADERS = ["Age", "Market cap", "24h", "Vol 24h", "Liquidity", "Holders"] as const;

function age(createdAt: number | null, now: number): string {
  if (createdAt === null) {
    return "—";
  }
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000)),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  return minutes < 60
    ? `${minutes}m`
    : hours < 48
      ? `${hours}h`
      : days < 60
        ? `${days}d`
        : days < 365
          ? `${Math.floor(days / 30)}mo`
          : `${Math.floor(days / 365)}y`;
}

/** Squint's grade as a word on its tone, with the 0 to 100 score (higher is riskier) beside it. */
function RiskBadge({ coin }: { readonly coin: MemecoinRow }): ReactElement {
  const verdict = coin.verdict ? VERDICTS[coin.verdict] : { label: "Not graded", tone: "neutral" as const };
  return (
    <span
      title={coin.risk === null ? undefined : `Squint risk score ${coin.risk} of 100; higher is riskier`}
      className={`inline-flex h-6 items-center gap-1.5 rounded-xs px-2 text-small font-medium whitespace-nowrap ring-1 ring-inset ${BADGE_TONES[verdict.tone]}`}
    >
      {verdict.label}
      {coin.risk === null ? null : <span className="font-mono tabular-nums">{coin.risk}</span>}
    </span>
  );
}

function Row({
  coin,
  now,
  onTrade,
}: {
  readonly coin: MemecoinRow;
  readonly now: number;
  readonly onTrade: (coin: MemecoinRow) => void;
}): ReactElement {
  const launchpad = LAUNCHPADS[coin.launchpad] ?? coin.launchpad;
  return (
    <tr className="border-b border-line-subtle transition-colors duration-200 ease-ios hover:bg-surface-1">
      <td className={CELL}>
        <span className="flex min-w-0 items-center gap-2.5">
          <TokenIcon symbol={coin.symbol} icon={coin.icon} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="max-w-40 truncate font-medium text-fg-strong" title={coin.token}>
              {coin.symbol}
            </span>
            <span className="max-w-40 truncate text-caption text-fg-subtle" title={coin.name}>
              {coin.name} · {launchpad}
            </span>
          </span>
        </span>
      </td>
      <td className={`${NUM} text-fg-muted`}>{age(coin.createdAt, now)}</td>
      <td className={`${NUM} text-fg-strong`}>{compactUsd(coin.marketCap)}</td>
      <td className={NUM}>
        <Change value={coin.change24h} />
      </td>
      <td className={`${NUM} text-fg`}>{compactUsd(coin.volume24h)}</td>
      <td className={`${NUM} text-fg`}>{compactUsd(coin.liquidity)}</td>
      <td className={`${NUM} text-fg`}>
        {coin.holdersCapped && coin.holders >= 100 ? "100+" : compactCount(coin.holders)}
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        <RiskBadge coin={coin} />
      </td>
      <td className={`${CELL} text-right`}>
        {coin.asset ? (
          <button
            type="button"
            onClick={() => onTrade(coin)}
            aria-label={`Trade ${coin.symbol}`}
            className={TRADE_BUTTON}
          >
            Trade
          </button>
        ) : (
          <a
            href={`https://www.nearsquint.tech/?q=${encodeURIComponent(coin.token)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${coin.symbol} details on Squint (opens in a new tab)`}
            className={TRADE_BUTTON}
          >
            Details
          </a>
        )}
      </td>
    </tr>
  );
}

function SkeletonRows(): ReactElement {
  return (
    <>
      {SKELETON_ROWS.map((row) => (
        <tr key={row} className="border-b border-line-subtle">
          <td className={CELL}>
            <span className="flex items-center gap-2.5">
              <span className={`${BLOCK} size-6 rounded-full`} />
              <span className="flex flex-col gap-1.5">
                <span className={`${BLOCK} h-3.5 w-14`} />
                <span className={`${BLOCK} h-3 w-24`} />
              </span>
            </span>
          </td>
          {HEADERS.map((cell) => (
            <td key={cell} className={CELL}>
              <span className={`${BLOCK} ml-auto h-3.5 w-12`} />
            </td>
          ))}
          <td className={CELL}>
            <span className={`${BLOCK} h-6 w-20`} />
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} ml-auto h-8 w-16 rounded-full`} />
          </td>
        </tr>
      ))}
    </>
  );
}

interface MemecoinsTableProps {
  /** null while the first read loads: the header stays and placeholder rows show. */
  readonly coins: readonly MemecoinRow[] | null;
  /** When the rows were read (epoch ms), for the age column. */
  readonly now: number;
  readonly onTrade: (coin: MemecoinRow) => void;
}

/** NEAR memecoins flat on the page: age, market cap, 24 h change and volume, liquidity, holders and risk grade. */
export function MemecoinsTable({ coins, now, onTrade }: MemecoinsTableProps): ReactElement {
  return (
    <div className="-mx-gutter overflow-x-auto px-gutter">
      <table
        className="w-full min-w-4xl border-collapse text-small"
        aria-busy={coins === null}
        aria-label="Memecoins"
      >
        <thead>
          <tr className="border-b border-line-card">
            <th scope="col" className={HEAD}>
              Token
            </th>
            {HEADERS.map((label) => (
              <th key={label} scope="col" className={`${HEAD} text-right`}>
                {label === "24h" ? <span className="sr-only">Price change </span> : null}
                {label}
              </th>
            ))}
            <th scope="col" className={HEAD}>
              Risk
            </th>
            <th scope="col" className={HEAD}>
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {coins === null ? (
            <SkeletonRows />
          ) : (
            coins.map((coin) => <Row key={coin.token} coin={coin} now={now} onTrade={onTrade} />)
          )}
        </tbody>
      </table>
    </div>
  );
}
