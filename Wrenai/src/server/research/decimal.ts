import { formatUnits } from "@/shared/money";

export interface Decimal {
  readonly n: bigint;
  readonly d: bigint;
}

/** Exact bounded decimal/scientific input from public APIs; no financial value passes through Number. */
export function decimal(value: string): Decimal {
  if (value.length > 512) {
    throw new RangeError("Market decimal is too long.");
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match?.[2]) {
    throw new RangeError("Invalid market decimal.");
  }
  const fraction = match[3] ?? "";
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  if (exponent > 200n || exponent < -512n) {
    throw new RangeError("Market exponent is out of range.");
  }
  const n = BigInt(`${match[2]}${fraction}`) * (match[1] === "-" ? -1n : 1n);
  return exponent >= 0n ? { n: n * 10n ** exponent, d: 1n } : { n, d: 10n ** -exponent };
}
export function subtract(a: Decimal, b: Decimal): Decimal {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d };
}
export function ratio(a: Decimal, b: Decimal): Decimal {
  if (b.n === 0n) {
    throw new RangeError("Zero market denominator.");
  }
  return { n: a.n * b.d * (b.n < 0n ? -1n : 1n), d: a.d * b.n * (b.n < 0n ? -1n : 1n) };
}
export function compare(a: Decimal, b: Decimal): number {
  const delta = a.n * b.d - b.n * a.d;
  return delta > 0n ? 1 : delta < 0n ? -1 : 0;
}
export function displayDecimal(value: Decimal, digits = 4): string {
  if (value.n === 0n) {
    return "0";
  }
  // Display truncation never feeds decisions; nonzero tiny values keep a magnitude marker.
  const scaled = (value.n * 10n ** BigInt(digits)) / value.d;
  if (scaled === 0n && value.n !== 0n) {
    return `${value.n < 0n ? "−" : ""}<${digits ? `0.${"0".repeat(digits - 1)}1` : "1"}`;
  }
  return formatUnits(scaled, { decimals: digits, fractionDigits: digits });
}
export function product(a: Decimal, b: Decimal): Decimal {
  return { n: a.n * b.n, d: a.d * b.d };
}
/** A plain "-12.34" string with `digits` fraction digits, truncated toward zero (display only, no grouping). */
export function plainDecimal(value: Decimal, digits: number): string {
  const scaled = (value.n * 10n ** BigInt(digits)) / value.d,
    negative = scaled < 0n,
    text = (negative ? -scaled : scaled).toString().padStart(digits + 1, "0");
  const whole = text.slice(0, text.length - digits),
    fraction = text.slice(text.length - digits);
  return `${negative ? "-" : ""}${whole}${digits ? `.${fraction}` : ""}`;
}
export function percent(value: Decimal): string {
  return `${displayDecimal({ n: value.n * 100n, d: value.d }, 2)}%`;
}
export function price(value: string): string {
  const parsed = decimal(value);
  const magnitude = parsed.n < 0n ? -parsed.n : parsed.n;
  const digits = magnitude >= parsed.d * 1000n ? 2 : magnitude >= parsed.d ? 4 : 8;
  return `$${displayDecimal(parsed, digits)}`;
}
export function tokenUnits(value: string, decimals: number): bigint {
  const parsed = decimal(value);
  const scaled = parsed.n * 10n ** BigInt(decimals);
  if (scaled < 0n || scaled % parsed.d !== 0n) {
    throw new RangeError("Amount exceeds token precision.");
  }
  return scaled / parsed.d;
}
