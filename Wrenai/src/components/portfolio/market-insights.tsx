"use client";

import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { type ReactElement, type ReactNode, useState } from "react";
import { Change, compactUsd } from "@/components/trading/market-cells";
import { TokenIcon } from "@/components/trading/token-icon";
import { readTrading } from "@/components/trading/trading-api";
import {
  type InsightCard,
  type InsightRow,
  listInsightSchema,
  spotInsightSchema,
} from "@/shared/portfolio-insights";
import { decimalDisplay } from "@/shared/trading-display";
import { PortfolioPanel } from "./panel";

// Docs/DESIGN.md → Screens → Portfolio → Insights. The cards load in the browser after the page paints, each on
// its own, so a slow provider never holds the page.
//
// Typography (Docs/DESIGN.md → Typography): the title is `h3` in sentence case; every row is one `small` size,
// split by weight and color rather than size (symbol 500 `fg-strong`, meta 400 `fg-subtle`; figures in Geist Mono
// with tabular numbers). Both sizes are fluid tokens. A row is two lines, label column left and figure column
// right, so each line shares one baseline across the row. Placeholders use `h-lh` with the same text classes, so
// loading, empty and unavailable states keep the exact height of five real rows.
const LINE = "text-small";
const LIST = "flex flex-col divide-y divide-line-card";
const ITEM = "flex min-w-0 items-center gap-3 py-2.5 first:pt-0 last:pb-0";
const BLOCK = "block rounded-xs bg-surface-2";
// One key per row of INSIGHT_ROWS (shared/portfolio-insights.ts).
const PLACEHOLDER_KEYS = ["a", "b", "c", "d", "e"] as const;
const FRESH_MS = 60_000;

const VERDICT = {
  clean: { label: "Clean", tone: "text-gain" },
  caution: { label: "Caution", tone: "text-warn" },
  danger: { label: "Danger", tone: "text-loss" },
} as const;

interface CardSpec {
  readonly id: string;
  readonly title: string;
  readonly href: Route;
  readonly link: string;
}

const SPOT: CardSpec = {
  id: "spot-movers",
  title: "24h spot movers",
  href: "/spot",
  link: "All spot markets",
};
const PERPS: CardSpec = { id: "perps-volume", title: "Most traded perps", href: "/perps", link: "All perps" };
const MEMES: CardSpec = {
  id: "memecoin-volume",
  title: "Most traded memecoins",
  href: "/memecoins",
  link: "All memecoins",
};

function insightQuery(card: InsightCard) {
  return {
    queryKey: ["portfolio-insight", card],
    staleTime: FRESH_MS,
    refetchInterval: FRESH_MS,
    retry: 1,
  } as const;
}

/** The card's last line, pinned to its bottom so links line up across a row of cards. */
function CardLink({ spec }: { readonly spec: CardSpec }): ReactElement {
  return (
    <Link
      href={spec.href}
      className={`mt-auto self-end rounded-xs ${LINE} text-accent-text underline-offset-4 hover:underline`}
    >
      {spec.link}
    </Link>
  );
}

/** Five rows of line-tall blocks: the skeleton, and the invisible spacer behind a message. */
function PlaceholderRows({ pulse }: { readonly pulse: boolean }): ReactElement {
  const block = `${BLOCK} h-lh ${LINE} ${pulse ? "motion-safe:animate-pulse" : ""}`;
  return (
    <ul aria-hidden="true" className={LIST}>
      {PLACEHOLDER_KEYS.map((key) => (
        <li key={key} className={ITEM}>
          <span
            className={`${BLOCK} size-6 shrink-0 rounded-full ${pulse ? "motion-safe:animate-pulse" : ""}`}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`${block} w-16`} />
            <span className={`${block} w-24`} />
          </span>
          <span className="flex flex-col items-end">
            <span className={`${block} w-16`} />
            <span className={`${block} w-12`} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Message({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="grid">
      <div className="invisible col-start-1 row-start-1">
        <PlaceholderRows pulse={false} />
      </div>
      <p
        className={`col-start-1 row-start-1 flex items-center justify-center text-center ${LINE} text-fg-muted`}
      >
        {children}
      </p>
    </div>
  );
}

interface RowParts {
  /** Under the symbol: volume, or market cap and grade. */
  readonly meta: (row: InsightRow) => ReactNode;
  /** The figure column's first line: a price, or a market cap. */
  readonly figure: (row: InsightRow) => ReactNode;
}

function Rows({
  rows,
  parts,
}: {
  readonly rows: readonly InsightRow[];
  readonly parts: RowParts;
}): ReactElement {
  return (
    <ul className={LIST}>
      {rows.map((row) => (
        <li key={row.key} className={ITEM}>
          <TokenIcon symbol={row.symbol} icon={row.icon} size={24} />
          <span className={`flex min-w-0 flex-1 flex-col ${LINE}`}>
            <span className="truncate font-medium text-fg-strong" title={row.symbol}>
              {row.symbol}
            </span>
            <span className="truncate text-fg-subtle">{parts.meta(row)}</span>
          </span>
          <span className={`flex shrink-0 flex-col items-end font-mono tabular-nums ${LINE}`}>
            <span className="text-fg-strong">{parts.figure(row)}</span>
            <Change value={row.change24h} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Loading, unavailable, empty or rows, always in the box of five real rows. */
function CardBody({
  rows,
  failed,
  empty,
  parts,
}: {
  readonly rows: readonly InsightRow[] | undefined;
  readonly failed: boolean;
  readonly empty: string;
  readonly parts: RowParts;
}): ReactElement {
  if (rows === undefined) {
    return failed ? (
      <Message>Market data is unavailable. Refresh to retry.</Message>
    ) : (
      <div role="status" aria-label="Loading markets">
        <PlaceholderRows pulse />
      </div>
    );
  }
  return rows.length ? <Rows rows={rows} parts={parts} /> : <Message>{empty}</Message>;
}

function price(row: InsightRow): string {
  return row.price ? `$${decimalDisplay(row.price)}` : "—";
}

function volume(row: InsightRow): string {
  return `Vol ${compactUsd(row.volume24h)}`;
}

const PRICE_PARTS: RowParts = { meta: volume, figure: price };

const MEMECOIN_PARTS: RowParts = {
  meta: (row) => {
    const verdict = row.verdict ? VERDICT[row.verdict] : null;
    return verdict ? (
      <>
        <span className={verdict.tone}>{verdict.label}</span> · {volume(row)}
      </>
    ) : (
      volume(row)
    );
  },
  figure: (row) => (
    <>
      {compactUsd(row.marketCap)}
      <span className="font-sans text-fg-subtle"> mcap</span>
    </>
  ),
};

type Side = "gainers" | "losers";

function SideToggle({
  side,
  onChange,
}: {
  readonly side: Side;
  readonly onChange: (side: Side) => void;
}): ReactElement {
  // 24 px tall (20 px buttons in a 2 px inset), the header's own height, so this card's rows start level with the
  // cards beside it.
  return (
    <fieldset className="flex shrink-0 items-center gap-0.5 rounded-full bg-sunken p-0.5 ring-1 ring-line-card ring-inset">
      <legend className="sr-only">Show gainers or losers</legend>
      {(["gainers", "losers"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={side === option}
          onClick={() => onChange(option)}
          className={`h-5 cursor-pointer rounded-full px-2.5 ${LINE} text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong aria-pressed:bg-surface-3 aria-pressed:text-fg-strong pointer-coarse:h-11`}
        >
          {option === "gainers" ? "Gainers" : "Losers"}
        </button>
      ))}
    </fieldset>
  );
}

function SpotMoversCard(): ReactElement {
  const [side, setSide] = useState<Side>("gainers");
  const query = useQuery({
    ...insightQuery("spot"),
    queryFn: ({ signal }) => readTrading("/api/portfolio/insights?card=spot", spotInsightSchema, signal),
  });
  return (
    <PortfolioPanel
      id={SPOT.id}
      title={SPOT.title}
      heading="title"
      aside={<SideToggle side={side} onChange={setSide} />}
    >
      <CardBody
        rows={query.data?.[side]}
        failed={query.isError}
        empty={side === "gainers" ? "No tokens are up over 24 hours." : "No tokens are down over 24 hours."}
        parts={PRICE_PARTS}
      />
      <CardLink spec={SPOT} />
    </PortfolioPanel>
  );
}

function ListCard({
  spec,
  card,
  empty,
  parts,
}: {
  readonly spec: CardSpec;
  readonly card: Exclude<InsightCard, "spot">;
  readonly empty: string;
  readonly parts: RowParts;
}): ReactElement {
  const query = useQuery({
    ...insightQuery(card),
    queryFn: ({ signal }) => readTrading(`/api/portfolio/insights?card=${card}`, listInsightSchema, signal),
  });
  return (
    <PortfolioPanel id={spec.id} title={spec.title} heading="title">
      <CardBody rows={query.data?.rows} failed={query.isError} empty={empty} parts={parts} />
      <CardLink spec={spec} />
    </PortfolioPanel>
  );
}

// One column on phones, two from md, three from xl; cards stretch to the row so their links line up.
const GRID = "grid gap-stack md:grid-cols-2 xl:grid-cols-3";

/** The whole row as skeletons, for the Portfolio route's loading screen. */
export function MarketInsightsSkeleton(): ReactElement {
  return (
    <div className={GRID}>
      {[SPOT, PERPS, MEMES].map((spec) => (
        <PortfolioPanel key={spec.id} id={`${spec.id}-loading`} title={spec.title} heading="title">
          <div role="status" aria-label="Loading markets">
            <PlaceholderRows pulse />
          </div>
          <CardLink spec={spec} />
        </PortfolioPanel>
      ))}
    </div>
  );
}

/** The Insights row: three market cards fetched in parallel in the browser, refreshed every minute. */
export function MarketInsights(): ReactElement {
  return (
    <div className={GRID}>
      <SpotMoversCard />
      <ListCard spec={PERPS} card="perps" empty="No perps markets right now." parts={PRICE_PARTS} />
      <ListCard spec={MEMES} card="memecoins" empty="No memecoin trading right now." parts={MEMECOIN_PARTS} />
    </div>
  );
}
