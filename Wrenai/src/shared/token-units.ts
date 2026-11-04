import { z } from "zod";

export const MAX_TOKEN_UNITS = (1n << 256n) - 1n;
export function minimumUnits(first: bigint, second: bigint): bigint {
  if (first < second) {
    return first;
  }
  return second;
}
export function maximumUnits(first: bigint, second: bigint): bigint {
  if (first > second) {
    return first;
  }
  return second;
}
export const tokenUnitsSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,77})$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => BigInt(value) <= MAX_TOKEN_UNITS,
        "Amount exceeds the supported unsigned 256-bit range.",
      ),
  );
export const positiveTokenUnitsSchema = tokenUnitsSchema.refine(
  (value) => value !== "0",
  "Amount must be positive.",
);

/** Convert a user-entered token amount without rounding or floating-point coercion. */
export function parseTokenAmount(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^(?:0|[1-9]\d{0,77})(?:\.\d{1,36})?$/.test(value)
  ) {
    throw new RangeError("Enter a valid token amount.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`This token supports at most ${decimals} decimal places.`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  positiveTokenUnitsSchema.parse(units.toString());
  return units;
}
