import { type TestnetRule, testnetAsset } from "./testnet";
import { parseTokenAmount } from "./token-units";

/** How many orders the rule's budget pays for: DCA repeats until the budget runs out; the other kinds run once. */
export function plannedOrders(rule: TestnetRule): number {
  if (rule.kind !== "dca") {
    return 1;
  }
  const decimals = testnetAsset(rule.assetId).decimals,
    amount = parseTokenAmount(rule.amount, decimals);
  return amount > 0n ? Number(parseTokenAmount(rule.budget, decimals) / amount) : 0;
}

/** How many of those orders fit between `startAt` and the end time, one every interval starting at once. */
export function ordersThatFit(rule: TestnetRule, startAt: number): number {
  const planned = plannedOrders(rule);
  if (rule.kind !== "dca") {
    return rule.expiresAt > startAt ? planned : 0;
  }
  if (rule.expiresAt <= startAt) {
    return 0;
  }
  return Math.min(planned, Math.floor((rule.expiresAt - 1 - startAt) / (rule.intervalSeconds * 1000)) + 1);
}

/**
 * The next DCA slot on a fixed grid from the one just run, so slots don't drift by each order's quote and signing
 * time. A late worker runs the latest missed slot once and skips the rest: never a catch-up burst (Spec §5).
 */
export function nextSlotAt(dueAt: number, intervalMs: number, now: number): number {
  const next = dueAt + intervalMs;
  if (next > now) {
    return next;
  }
  return next + Math.floor((now - next) / intervalMs) * intervalMs;
}
