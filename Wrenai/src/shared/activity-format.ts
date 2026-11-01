import type { ActivityAmount } from "./activity";
import { formatExactMicroUsd, formatUnits } from "./money";

export function formatActivityAmount(amount: ActivityAmount): {
  readonly display: string;
  readonly full: string;
} {
  if (amount.kind === "usd") {
    const full = formatExactMicroUsd(BigInt(amount.microUsd));
    return {
      display: `${amount.estimated ? "~" : ""}${full}`,
      full: `${full}${amount.estimated ? " recorded estimate" : ""}`,
    };
  }
  const units = BigInt(amount.units);
  const sign = units === 0n || amount.direction === "none" ? "" : amount.direction === "in" ? "+" : "−";
  const decimals = amount.decimals ?? 0;
  const full = formatUnits(units, { decimals, fractionDigits: decimals })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  const suffix = amount.decimals === null ? `${amount.symbol} base units` : amount.symbol;
  const digits = Math.min(decimals, 8);
  const scale = 10n ** BigInt(decimals - digits);
  const small = units > 0n && units < scale;
  const visible = small
    ? `<${digits ? `0.${"0".repeat(digits - 1)}1` : "1"}`
    : formatUnits(units, { decimals, fractionDigits: digits })
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "");
  const rounded = !small && units % scale !== 0n;
  return { display: `${sign}${rounded ? "~" : ""}${visible} ${suffix}`, full: `${sign}${full} ${suffix}` };
}
