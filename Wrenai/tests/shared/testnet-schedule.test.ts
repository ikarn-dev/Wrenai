import { describe, expect, it } from "vitest";
import { dcaWaitSeconds } from "@/server/engine/dca-schedule";
import type { TestnetRule } from "@/shared/testnet";
import { nextSlotAt, ordersThatFit, plannedOrders } from "@/shared/testnet-schedule";

const START = Date.UTC(2026, 10, 11, 15, 55);
const rule: TestnetRule = {
  name: "DCA",
  kind: "dca",
  assetId: "nep141:usdc.tidepool-sandbox.testnet",
  outputAssetId: "nep141:eth.tidepool-sandbox.testnet",
  recipient: null,
  amount: "0.5",
  budget: "5",
  intervalSeconds: 60,
  costBasis: null,
  thresholdBps: 500,
  expiresAt: START + 10 * 60_000,
};

describe("testnet DCA schedule", () => {
  it("keeps slots on a fixed grid however long an order took", () => {
    expect(nextSlotAt(START, 60_000, START + 7_000)).toBe(START + 60_000);
  });
  it("runs only the latest missed slot after a long delay, never a burst", () => {
    const next = nextSlotAt(START, 60_000, START + 200_000);
    expect(next).toBe(START + 180_000);
    expect(nextSlotAt(next, 60_000, START + 200_500)).toBe(START + 240_000);
  });
  it("counts the orders the budget pays for and how many fit before the end", () => {
    expect(plannedOrders(rule)).toBe(10);
    expect(ordersThatFit(rule, START)).toBe(10);
    expect(ordersThatFit(rule, START + 3 * 60_000)).toBe(7);
    expect(ordersThatFit({ ...rule, kind: "spot" }, START)).toBe(1);
    expect(ordersThatFit(rule, rule.expiresAt)).toBe(0);
  });
});

describe("mainnet DCA wake-up", () => {
  const schedule = { type: "interval", startAt: new Date(START).toISOString(), intervalSeconds: 60 } as const;
  it("wakes at the next slot instead of a fixed minute after the last check", () => {
    expect(dcaWaitSeconds(schedule, START + 15_500)).toBe(45);
    expect(dcaWaitSeconds(schedule, START + 59_900)).toBe(1);
  });
});
