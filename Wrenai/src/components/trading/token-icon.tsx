"use client";
import Image from "next/image";
import { type ReactElement, useState } from "react";

// A quiet letter mark when a token has no icon: two neutral greys picked from the symbol, so the same token always
// looks the same and no colour implies meaning.
const MARKS = ["bg-surface-3 text-fg", "bg-surface-4 text-fg-strong"] as const;

function markClass(symbol: string): string {
  let hash = 0;
  for (const char of symbol) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return MARKS[hash % MARKS.length] ?? MARKS[0];
}

/** Hyperliquid's coin icon for a Perps market. Not every market has one; a missing one falls back to the mark. */
export function perpsIcon(market: string): string {
  return `https://app.hyperliquid.xyz/coins/${encodeURIComponent(market)}.svg`;
}

interface TokenIconProps {
  readonly symbol: string;
  /**
   * An image URL. Raster icons on hosts next.config.ts allows (CoinGecko, Nearly, DEX Screener) go through the
   * optimizer; Hyperliquid's SVGs load as-is, since the optimizer doesn't serve SVG.
   */
  readonly icon: string | null;
  readonly size?: number;
}

/** The token's icon, otherwise (or if it fails to load) its first letter on a round grey mark. */
export function TokenIcon({ symbol, icon, size = 24 }: TokenIconProps): ReactElement {
  const [failed, setFailed] = useState<string | null>(null);
  if (icon && failed !== icon) {
    return (
      <Image
        src={icon}
        alt=""
        width={size}
        height={size}
        unoptimized={icon.endsWith(".svg")}
        onError={() => setFailed(icon)}
        className="shrink-0 rounded-full"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-caption font-medium ${markClass(symbol)}`}
    >
      {symbol
        .replace(/^w(?=[A-Z])/, "")
        .replace(/^k(?=[A-Z])/, "")
        .slice(0, 1)
        .toUpperCase()}
    </span>
  );
}
