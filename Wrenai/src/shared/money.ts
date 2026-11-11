const MINUS_SIGN = "\u2212";

/** USD values inside the app are integers in millionths of a dollar. */
export const MICRO_USD_DECIMALS = 6;

export interface FormatUnitsOptions {
  /** Decimals of the asset, e.g. 24 for NEAR, 6 for USDC. */
  readonly decimals: number;
  /** Digits shown after the decimal point. Fixed, so columns line up. */
  readonly fractionDigits: number;
}

/**
 * Formats an amount in smallest units as a decimal string with thousands separators.
 * Rounds toward zero, so a displayed balance is never larger than the real one.
 */
export function formatUnits(amount: bigint, options: FormatUnitsOptions): string {
  const { decimals, fractionDigits } = options;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > decimals) {
    throw new RangeError(`fractionDigits must be an integer from 0 to ${decimals}, got ${fractionDigits}`);
  }

  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = magnitude / unit;
  const fraction = (magnitude % unit).toString().padStart(decimals, "0").slice(0, fractionDigits);

  const wholeText = whole.toLocaleString("en-US");
  const body = fractionDigits > 0 ? `${wholeText}.${fraction}` : wholeText;
  const displaysZero = whole === 0n && /^0*$/.test(fraction);
  return negative && !displaysZero ? `${MINUS_SIGN}${body}` : body;
}

/** Formats micro-USD as dollars with cents, e.g. 12_500_000n → "$12.50". */
export function formatMicroUsd(amount: bigint): string {
  const text = formatUnits(amount, { decimals: MICRO_USD_DECIMALS, fractionDigits: 2 });
  return text.startsWith(MINUS_SIGN) ? `${MINUS_SIGN}$${text.slice(1)}` : `$${text}`;
}

/** Full configured precision for price levels and limits; trailing zeroes stop at cents. */
export function formatExactMicroUsd(amount: bigint): string {
  const text = formatUnits(amount, {
    decimals: MICRO_USD_DECIMALS,
    fractionDigits: MICRO_USD_DECIMALS,
  }).replace(/(\.\d{2,}?)0+$/, "$1");
  return text.startsWith(MINUS_SIGN) ? `${MINUS_SIGN}$${text.slice(1)}` : `$${text}`;
}

/** Compact USD display for narrow summary cards, rounded toward zero. */
export function formatCompactMicroUsd(amount: bigint): string {
  const magnitude = amount < 0n ? -amount : amount;
  for (const [unit, suffix] of [
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const) {
    if (magnitude >= unit * 1_000_000n) {
      const tenths = (magnitude * 10n) / (unit * 1_000_000n);
      return `${amount < 0n ? "−" : ""}$${tenths / 10n}.${tenths % 10n}${suffix}`;
    }
  }
  if (magnitude > 0n && magnitude < 10_000n) {
    return `${amount < 0n ? "−" : ""}<$0.01`;
  }
  return formatMicroUsd(amount);
}

/** A token amount for display: at most four decimals, rounded down so it never reads larger than it is. */
export function shortTokenAmount(units: string, decimals: number): string {
  const amount = BigInt(units);
  const fractionDigits = Math.min(decimals, 4);
  if (amount > 0n && amount < 10n ** BigInt(decimals - fractionDigits)) {
    return "<0.0001";
  }
  const text = formatUnits(amount, { decimals, fractionDigits });
  return fractionDigits === 0 ? text : text.replace(/\.?0+$/, "");
}
