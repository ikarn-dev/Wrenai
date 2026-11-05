"use client";
import type { ReactElement } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import type { ChangePeriod, SpotMarketToken } from "@/shared/market-pages";
import { decimalDisplay } from "@/shared/trading-display";
import { middleTruncate } from "@/shared/truncate";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";
import { BLOCK, CELL, Change, compactUsd, HEAD, NUM, SKELETON_ROWS, TRADE_BUTTON } from "./market-cells";
import { TokenIcon } from "./token-icon";

const NETWORK: Readonly<Record<string, string>> = {
  near: "NEAR",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  sol: "Solana",
  btc: "Bitcoin",
  bsc: "BNB Chain",
  op: "Optimism",
  pol: "Polygon",
  avax: "Avalanche",
  gnosis: "Gnosis",
  tron: "Tron",
  ton: "TON",
  sui: "Sui",
  aptos: "Aptos",
  starknet: "Starknet",
  stellar: "Stellar",
};

export function networkName(id: string): string {
  return NETWORK[id] ?? id.toUpperCase();
}

/** wNEAR is 1:1 with NEAR and unwraps freely, so the Spot page calls it NEAR; the contract column still says wrap.near. */
export function displaySymbol(token: SpotMarketToken): string {
  return token.assetId === WALLET_SWAP_INPUT ? "wNEAR" : token.tokenSymbol;
}

function displayName(token: SpotMarketToken): string | undefined {
  return token.assetId === WALLET_SWAP_INPUT ? "Wrapped NEAR" : token.metrics?.name;
}

function Row({
  token,
  period,
  onTrade,
}: {
  readonly token: SpotMarketToken;
  readonly period: ChangePeriod;
  readonly onTrade: (token: SpotMarketToken) => void;
}): ReactElement {
  const contract = token.contractAddress ?? token.assetId,
    network = networkName(token.blockchain),
    symbol = displaySymbol(token),
    name = displayName(token);
  return (
    <tr className="border-b border-line-subtle transition-colors duration-200 ease-ios hover:bg-surface-1">
      <td className={CELL}>
        <span className="flex min-w-0 items-center gap-2.5">
          <TokenIcon symbol={symbol} icon={token.metrics?.icon ?? null} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-fg-strong">{symbol}</span>
            <span className="truncate text-caption text-fg-subtle" title={name ?? network}>
              {name ? `${name} · ${network}` : network}
            </span>
          </span>
        </span>
      </td>
      <td className={`${NUM} text-fg-strong`}>{token.price ? `$${decimalDisplay(token.price)}` : "—"}</td>
      <td className={NUM}>
        <Change value={token.metrics?.change[period] ?? null} />
      </td>
      <td className={`${NUM} text-fg`}>{compactUsd(token.metrics?.marketCap ?? null)}</td>
      <td className={`${NUM} text-fg`}>{compactUsd(token.metrics?.volume24h ?? null)}</td>
      <td className={`${CELL} whitespace-nowrap`}>
        <span className="inline-flex items-center gap-0.5">
          <span className="font-mono text-caption text-fg-muted" title={contract}>
            {middleTruncate(contract, 10, 6)}
          </span>
          <CopyButton text={contract} label="Copy contract" />
        </span>
      </td>
      <td className={`${CELL} text-right`}>
        <button
          type="button"
          onClick={() => onTrade(token)}
          aria-label={`Trade ${symbol} on ${network}`}
          className={TRADE_BUTTON}
        >
          Trade
        </button>
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
          {["price", "change", "cap", "volume"].map((cell) => (
            <td key={cell} className={CELL}>
              <span className={`${BLOCK} ml-auto h-3.5 w-16`} />
            </td>
          ))}
          <td className={CELL}>
            <span className={`${BLOCK} h-3.5 w-28`} />
          </td>
          <td className={CELL}>
            <span className={`${BLOCK} ml-auto h-8 w-16 rounded-full`} />
          </td>
        </tr>
      ))}
    </>
  );
}

interface SpotMarketsTableProps {
  /** null while the first read loads: the table keeps its header and shows placeholder rows. */
  readonly tokens: readonly SpotMarketToken[] | null;
  readonly period: ChangePeriod;
  readonly onTrade: (token: SpotMarketToken) => void;
}

/** Spot tokens flat on the page: hairline rows with price, change over the chosen period, market cap and volume. */
export function SpotMarketsTable({ tokens, period, onTrade }: SpotMarketsTableProps): ReactElement {
  return (
    <div className="-mx-gutter overflow-x-auto px-gutter">
      <table
        className="w-full min-w-3xl border-collapse text-small"
        aria-busy={tokens === null}
        aria-label="Spot markets"
      >
        <thead>
          <tr className="border-b border-line-card">
            <th scope="col" className={HEAD}>
              Token
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Price
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              <span className="sr-only">Price change </span>
              {period}
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Market cap
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Vol 24h
            </th>
            <th scope="col" className={HEAD}>
              Contract
            </th>
            <th scope="col" className={HEAD}>
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens === null ? (
            <SkeletonRows />
          ) : (
            tokens.map((token) => <Row key={token.assetId} token={token} period={period} onTrade={onTrade} />)
          )}
        </tbody>
      </table>
    </div>
  );
}
