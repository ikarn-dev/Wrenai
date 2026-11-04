import Image from "next/image";
import type { ReactElement } from "react";

// A quiet letter mark when a token has no inline icon: two neutral greys picked from the symbol, so the same
// token always looks the same and no colour implies meaning.
const MARKS = ["bg-surface-3 text-fg", "bg-surface-4 text-fg-strong"] as const;

function markClass(symbol: string): string {
  let hash = 0;
  for (const char of symbol) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return MARKS[hash % MARKS.length] ?? MARKS[0];
}

interface TokenIconProps {
  readonly symbol: string;
  /** An inline data:image URI from the token's NEP-148 metadata. */
  readonly icon?: string | undefined;
  readonly size?: number;
}

/** The token's own icon when NEAR metadata has one, otherwise its first letter on a round grey mark. */
export function TokenIcon({ symbol, icon, size = 24 }: TokenIconProps): ReactElement {
  if (icon) {
    // An inline data URI: nothing to fetch or resize, so the optimizer is skipped.
    return (
      <Image src={icon} alt="" width={size} height={size} unoptimized className="shrink-0 rounded-full" />
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
        .slice(0, 1)
        .toUpperCase()}
    </span>
  );
}
