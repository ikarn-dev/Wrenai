import { formatUnits } from "./money";

/** Display-only exact decimal formatting. Nonzero tiny values never become a displayed zero. */
export function decimalDisplay(value: string, percent = false): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match?.[2]) {
    return "—";
  }
  const fraction = match[3] ?? "",
    scale = fraction.length;
  const raw = BigInt(`${match[1] ?? ""}${match[2]}${fraction}`) * (percent ? 100n : 1n);
  const digits = Math.min(scale, percent ? 4 : 6),
    magnitude = raw < 0n ? -raw : raw;
  if (magnitude > 0n && magnitude < 10n ** BigInt(Math.max(0, scale - digits))) {
    return `${raw < 0n ? "−" : ""}<${digits ? `0.${"0".repeat(digits - 1)}1` : "1"}${percent ? "%" : ""}`;
  }
  return `${formatUnits(raw, { decimals: scale, fractionDigits: digits })
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "")}${percent ? "%" : ""}`;
}
