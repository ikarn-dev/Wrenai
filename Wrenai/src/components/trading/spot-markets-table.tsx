"use client";
import type { ReactElement } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import type { SpotMarketToken, TokenIcons } from "@/shared/market-pages";
import { decimalDisplay } from "@/shared/trading-display";
import { middleTruncate } from "@/shared/truncate";
import { TokenIcon } from "./token-icon";

const CELL = "px-3 py-2.5 first:pl-0 last:pr-0";
const HEAD = `${CELL} py-2 text-left text-caption font-medium text-fg-subtle whitespace-nowrap`;

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

function network(id: string): string {
  return NETWORK[id] ?? id.toUpperCase();
}

function age(updatedAt: number | null, now: number): string {
  if (updatedAt === null) {
    return "—";
  }
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

interface SpotMarketsTableProps {
  readonly tokens: readonly SpotMarketToken[];
  readonly icons: TokenIcons;
  readonly observedAt: number;
  readonly onTrade: (token: SpotMarketToken) => void;
}

/** Every token 1Click lists, flat on the page: hairline rows, the token's icon and network, price, contract. */
export function SpotMarketsTable({
  tokens,
  icons,
  observedAt,
  onTrade,
}: SpotMarketsTableProps): ReactElement {
  return (
    <div className="-mx-gutter overflow-x-auto px-gutter">
      <table className="w-full min-w-3xl border-collapse text-small">
        <thead>
          <tr className="border-b border-line-card">
            <th scope="col" className={HEAD}>
              Token
            </th>
            <th scope="col" className={HEAD}>
              Network
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Price
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Updated
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
          {tokens.map((token) => {
            const contract = token.contractAddress ?? token.assetId;
            return (
              <tr
                key={token.assetId}
                className="group border-b border-line-subtle transition-colors duration-200 ease-ios hover:bg-surface-1"
              >
                <td className={CELL}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <TokenIcon symbol={token.tokenSymbol} icon={icons[token.assetId]} size={22} />
                    <span className="truncate font-medium text-fg-strong">{token.tokenSymbol}</span>
                  </span>
                </td>
                <td className={`${CELL} whitespace-nowrap text-fg-muted`}>{network(token.blockchain)}</td>
                <td className={`${CELL} whitespace-nowrap text-right font-mono tabular-nums text-fg-strong`}>
                  {token.price ? `$${decimalDisplay(token.price)}` : "—"}
                </td>
                <td className={`${CELL} whitespace-nowrap text-right font-mono tabular-nums text-fg-subtle`}>
                  {age(token.priceUpdatedAt, observedAt)}
                </td>
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
                    aria-label={`Trade ${token.tokenSymbol} on ${network(token.blockchain)}`}
                    className="inline-flex h-8 cursor-pointer items-center rounded-full bg-surface-3 px-3.5 text-caption font-medium text-fg-strong ring-1 ring-line-strong/40 ring-inset transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-4 active:scale-95 motion-reduce:active:scale-100 pointer-coarse:h-11"
                  >
                    Trade
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
