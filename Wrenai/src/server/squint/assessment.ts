import { compare, decimal } from "@/server/research/decimal";
import { SQUINT_CHECKS, type SquintReport } from "./contracts";

export interface MemeScreenPolicy {
  readonly maximumAgeSeconds: number;
  readonly maximumHolderBps: number;
}
export interface MemeScreen {
  readonly passed: boolean;
  readonly checkedAt: number;
  readonly reasons: readonly string[];
}
/** Provider findings are admission inputs, not a signature grant or proof of a contract audit. */
export function screenMemeReport(report: SquintReport, policy: MemeScreenPolicy, now: number): MemeScreen {
  const reasons: string[] = [],
    checkedAt = Date.parse(report.checked_at),
    created = report.created_at === null ? Number.NaN : Date.parse(report.created_at);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 1000 || now - checkedAt >= 60000) {
    reasons.push("The token risk report is older than one minute or has an invalid time.");
  }
  if (!Number.isFinite(created) || created > now || now - created > policy.maximumAgeSeconds * 1000) {
    reasons.push("A listing inside the reviewed age window is not established.");
  }
  if (report.verdict !== "clean" || report.risk === null) {
    reasons.push("The provider has not returned a clean, scored report.");
  }
  for (const id of SQUINT_CHECKS) {
    const check = report.checks.find((value) => value.id === id);
    if (check?.status !== "good") {
      reasons.push(check ? `${check.label}: ${check.status}.` : `Required ${id} evidence is missing.`);
    }
  }
  if (
    report.checks.some((check) => !SQUINT_CHECKS.some((id) => id === check.id) && check.status !== "good")
  ) {
    reasons.push("An additional provider risk check is flagged or unknown.");
  }
  if (
    !report.coverage.transfers_complete ||
    report.coverage.wallets_checked === 0 ||
    report.coverage.wallets_traced !== report.coverage.wallets_checked
  ) {
    reasons.push("Transfer history or traced-holder coverage is incomplete.");
  }
  if (!report.holders.length) {
    reasons.push("Holder concentration could not be established.");
  }
  const bound = { n: BigInt(policy.maximumHolderBps), d: 10000n };
  if (
    report.holders.some((holder) => compare(decimal(holder.share), bound) > 0) ||
    report.clusters.some((cluster) => compare(decimal(cluster.share), bound) > 0) ||
    compare(decimal(report.supply.dev), bound) > 0
  ) {
    reasons.push("A holder, developer or linked group exceeds the reviewed concentration limit.");
  }
  if (
    report.tax.status !== "none" ||
    report.tax.buy_pct === null ||
    report.tax.sell_pct === null ||
    decimal(report.tax.buy_pct).n !== 0n ||
    decimal(report.tax.sell_pct).n !== 0n
  ) {
    reasons.push("Zero transfer/trade tax is not established for this route.");
  }
  if (report.market.liquidity_near === null || decimal(report.market.liquidity_near).n <= 0n) {
    reasons.push("Positive pool liquidity is not established.");
  }
  return { passed: reasons.length === 0, checkedAt, reasons };
}
