import { z } from "zod";
import { tradingDecimalSchema } from "./manual-trading";
import { parseTokenAmount } from "./token-units";

const fractionTerm = z.string().regex(/^[1-9]\d{0,17}$/);
const fraction = z
  .strictObject({ kind: z.literal("fraction"), numerator: fractionTerm, denominator: fractionTerm })
  .refine(
    ({ numerator, denominator }) =>
      numerator.length < denominator.length ||
      (numerator.length === denominator.length && numerator <= denominator),
    "Choose up to the full balance.",
  );
export const tradeSizeSchema = z.union([
  tradingDecimalSchema,
  fraction,
  z.strictObject({ kind: z.literal("leave"), amount: tradingDecimalSchema }),
]);
export type TradeSize = z.infer<typeof tradeSizeSchema>;

/** Resolve only against verified, spendable units. Fractional token units round down. */
export function tradeSizeUnits(size: TradeSize, decimals: number, available: bigint): bigint {
  if (typeof size === "string") {
    return parseTokenAmount(size, decimals);
  }
  if (size.kind === "leave") {
    return available - parseTokenAmount(size.amount, decimals);
  }
  return (available * BigInt(size.numerator)) / BigInt(size.denominator);
}
