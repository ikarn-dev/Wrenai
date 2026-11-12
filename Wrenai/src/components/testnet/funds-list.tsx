"use client";
import type { ReactElement } from "react";
import { TokenIcon } from "@/components/trading/token-icon";
import { formatUnits } from "@/shared/money";
import { type TestnetAsset, type TestnetSnapshot, testnetAsset } from "@/shared/testnet";

type Balance = TestnetSnapshot["balances"][number];

// CoinGecko logos for the tokens the Tidepool sandbox mirrors (an allowed image host in next.config.ts). wNEAR is
// wrapped NEAR, so it shows NEAR's mark. Any other token falls back to TokenIcon's letter mark.
const IMAGES = "https://coin-images.coingecko.com/coins/images";
const ICONS: Readonly<Record<string, string>> = {
  NEAR: `${IMAGES}/10365/large/near.jpg`,
  wNEAR: `${IMAGES}/10365/large/near.jpg`,
  USDC: `${IMAGES}/6319/large/usdc.png`,
  USDT: `${IMAGES}/325/large/Tether.png`,
  ETH: `${IMAGES}/279/large/ethereum.png`,
  wBTC: `${IMAGES}/7598/large/wrapped_bitcoin_wbtc.png`,
  XAUT: `${IMAGES}/10481/large/Tether_Gold.png`,
};
// Fixed decimals per asset (Docs/DESIGN.md → Numbers): dollars 2, NEAR 4; the rest up to six significant digits.
const FIXED: Readonly<Record<string, number>> = { USDC: 2, USDT: 2, NEAR: 4, wNEAR: 4 };
const SIGNIFICANT = 6;

/** Rounded down, so a balance never reads larger than it is; the exact amount is in the tooltip. */
function amountText(units: bigint, asset: TestnetAsset): string {
  const fixed = FIXED[asset.symbol];
  if (fixed !== undefined) {
    const digits = Math.min(fixed, asset.decimals);
    if (units > 0n && units < 10n ** BigInt(asset.decimals - digits)) {
      return `<0.${"0".repeat(Math.max(0, digits - 1))}1`;
    }
    return formatUnits(units, { decimals: asset.decimals, fractionDigits: digits });
  }
  const unit = 10n ** BigInt(asset.decimals),
    whole = units / unit;
  const leadingZeros = whole > 0n ? 0 : asset.decimals - (units % unit).toString().length;
  const digits = Math.min(
    asset.decimals,
    whole > 0n ? Math.max(0, SIGNIFICANT - whole.toString().length) : leadingZeros + SIGNIFICANT,
  );
  const text = formatUnits(units, { decimals: asset.decimals, fractionDigits: digits });
  return digits === 0 ? text : text.replace(/\.?0+$/, "");
}

function exact(units: bigint, asset: TestnetAsset): string {
  return formatUnits(units, { decimals: asset.decimals, fractionDigits: asset.decimals }).replace(
    /\.?0+$/,
    "",
  );
}

function FundRow({ balance }: { readonly balance: Balance }): ReactElement {
  const asset = testnetAsset(balance.assetId),
    units = BigInt(balance.units),
    reserved = BigInt(balance.reserved),
    available = units - reserved;
  return (
    <li className="flex min-h-12 min-w-0 items-center justify-between gap-4 py-2.5">
      <span className="flex min-w-0 items-center gap-3">
        <TokenIcon symbol={asset.symbol} icon={ICONS[asset.symbol] ?? null} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-small font-medium text-fg-strong">{asset.symbol}</span>
          <span className="truncate text-caption text-fg-subtle">
            {balance.location === "intents" ? "Public Intents" : "Wallet"}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span
          title={`${exact(available, asset)} ${asset.symbol} available`}
          className="font-mono text-small text-fg-strong tabular-nums"
        >
          {amountText(available, asset)} <span className="text-fg-muted">{asset.symbol}</span>
        </span>
        {reserved > 0n ? (
          <span className="font-mono text-caption text-fg-subtle tabular-nums">
            +{amountText(reserved, asset)} held by agents
          </span>
        ) : null}
      </span>
    </li>
  );
}

const ORDER = ["NEAR", "USDC", "USDT", "wNEAR", "ETH", "wBTC", "XAUT"];

/**
 * Every test balance this session holds, wallet and Public Intents, with what agents hold apart from what is free.
 * Zero balances are left out; native NEAR comes first, then the stablecoins.
 */
export function TestnetFundsList({ balances }: { readonly balances: readonly Balance[] }): ReactElement {
  const held = balances
    .filter((b) => BigInt(b.units) > 0n)
    .toSorted((a, b) => {
      const rank = (balance: Balance) => ORDER.indexOf(testnetAsset(balance.assetId).symbol);
      return rank(a) - rank(b) || a.location.localeCompare(b.location);
    });
  if (held.length === 0) {
    return (
      <p className="flex flex-1 items-center border-y border-line-card py-4 text-small text-fg-muted">
        No test funds in this session.
      </p>
    );
  }
  return (
    <ul
      aria-label="Test funds"
      className="flex flex-1 flex-col divide-y divide-line-card border-y border-line-card"
    >
      {held.map((balance) => (
        <FundRow key={`${balance.location}:${balance.assetId}`} balance={balance} />
      ))}
    </ul>
  );
}
