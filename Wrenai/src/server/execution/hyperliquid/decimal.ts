import { ExecutionError } from "../contracts";
import { hlDecimalSchema, hlSignedDecimalSchema } from "./contracts";

export function hlUnits(
  value: string,
  decimals: number,
  rounding: "reject" | "down" | "up" = "reject",
): bigint {
  hlSignedDecimalSchema.parse(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError("Invalid venue precision.");
  }
  const negative = value.startsWith("-"),
    [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const dust = /[1-9]/.test(fraction.slice(decimals));
  if (dust && rounding === "reject") {
    throw new ExecutionError("limit", "The amount has more decimal places than this venue market supports.");
  }
  let units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (dust && ((rounding === "up" && !negative) || (rounding === "down" && negative))) {
    units += 1n;
  }
  return negative ? -units : units;
}
export function hlText(units: bigint, decimals: number): string {
  const magnitude = units < 0n ? -units : units,
    scale = 10n ** BigInt(decimals);
  const fraction = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units < 0n ? "-" : ""}${magnitude / scale}${decimals && fraction ? `.${fraction}` : ""}`;
}
/** Price rounds inward to the user's bound: buy ceilings down, sell floors up. */
export function hlPrice(value: string, sizeDecimals: number, rounding: "down" | "up"): string {
  hlDecimalSchema.parse(value);
  if (!Number.isInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 6) {
    throw new RangeError("Unsupported perpetual size precision.");
  }
  const scaled = hlUnits(value, 18, "reject");
  if (scaled <= 0n) {
    throw new ExecutionError("limit", "A positive venue price is required.");
  }
  const whole = scaled / 10n ** 18n;
  // Integer prices are permitted regardless of significant figures.
  const digits = whole > 0n ? whole.toString().length : 0;
  let leadingZeros = 0;
  if (whole === 0n) {
    const fraction = scaled.toString().padStart(18, "0");
    leadingZeros = fraction.search(/[1-9]/);
  }
  const precision = Math.max(0, Math.min(6 - sizeDecimals, digits ? 5 - digits : 5 + leadingZeros));
  const divisor = 10n ** BigInt(18 - precision);
  const rounded = (scaled + (rounding === "up" ? divisor - 1n : 0n)) / divisor;
  if (rounded === 0n) {
    throw new ExecutionError("limit", "The price is smaller than this venue's minimum tick.");
  }
  return hlText(rounded, precision);
}
