import { marketFixture, perpsInstruction, perpsPolicy } from "@tests/server/execution/hyperliquid/fixtures";
import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { hlActionSchema } from "@/server/execution/hyperliquid/contracts";
import { hlPrice, hlText, hlUnits } from "@/server/execution/hyperliquid/decimal";
import {
  composePerpsOrder,
  composePerpsProtection,
  tightenedPerpsStop,
} from "@/server/execution/hyperliquid/order-plan";
import { hlActionHash, signHlAction } from "@/server/execution/hyperliquid/signing";

vi.mock("server-only", () => ({}));
describe("Hyperliquid exact protocol and independently published signing vectors", () => {
  it("matches the official Python SDK action hash without a cloid or expiry", () => {
    const action = hlActionSchema.parse({
      type: "order",
      orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });
    expect(hlActionHash(action, 1677777606040, null)).toBe(
      "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
    );
  });
  it("matches the SDK's mainnet EIP-712 signature and binds expiry, nonce and cloid", () => {
    const wallet = new Wallet("0x0123456789012345678901234567890123456789012345678901234567890123");
    const action = hlActionSchema.parse({
      type: "order",
      orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    });
    expect(signHlAction(wallet, action, 0, null)).toEqual({
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      v: 28,
    });
    expect(hlActionHash(action, 0, null)).not.toBe(hlActionHash(action, 0, 100));
    expect(hlActionHash(action, 0, 100)).not.toBe(hlActionHash(action, 1, 100));
    const withCloid = hlActionSchema.parse({
      ...action,
      orders:
        action.type === "order"
          ? action.orders.map((order) => ({ ...order, c: "0x00000000000000000000000000000001" }))
          : [],
    });
    expect(signHlAction(wallet, withCloid, 0, null)).toEqual({
      r: "0x041ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
      v: 27,
    });
  });
  it.each([
    ["123.456789", 2, "down", "123.45"],
    ["123.456789", 2, "up", "123.46"],
    ["0.000012345", 0, "down", "0.000012"],
    ["99999.9", 0, "up", "100000"],
    ["123456789", 2, "down", "123456789"],
  ] as const)("rounds %s inward with size precision %s", (value, size, direction, expected) => {
    expect(hlPrice(value, size, direction)).toBe(expected);
  });
  it("never silently truncates base size and handles signed cash rounding exactly", () => {
    expect(() => hlUnits("1.001", 2)).toThrow();
    expect(hlUnits("-1.0000001", 6, "down")).toBe(-1000001n);
    expect(hlUnits("-1.0000001", 6, "up")).toBe(-1000000n);
    expect(hlText(100n, 0)).toBe("100");
    expect(() => hlPrice("0.0000001", 0, "down")).toThrow();
  });
});
describe("reviewed isolated entries and protection", () => {
  it("binds isolated leverage, exact size and bounded native limit TP/SL with unique cloids", () => {
    const plan = composePerpsOrder(
      perpsInstruction(),
      perpsPolicy,
      marketFixture(),
      crypto.randomUUID(),
      20_000_000n,
    );
    expect(plan.leverage).toEqual({ type: "updateLeverage", asset: 7, isCross: false, leverage: 4 });
    if (plan.action.type !== "order") {
      throw new Error("Missing order.");
    }
    expect(plan.action.grouping).toBe("normalTpsl");
    expect(plan.action.orders[0]).toMatchObject({ s: "4", b: true, r: false, t: { limit: { tif: "Ioc" } } });
    expect(plan.action.orders[1]).toMatchObject({
      s: "4",
      b: false,
      r: true,
      t: { trigger: { isMarket: false, triggerPx: "4", tpsl: "sl" } },
    });
    expect(new Set(plan.action.orders.map((order) => order.c)).size).toBe(3);
  });
  it("rejects insufficient depth, stale books, bad stops, minimums, fees and tier-excess leverage", () => {
    const market = marketFixture();
    expect(() =>
      composePerpsOrder(
        perpsInstruction(),
        perpsPolicy,
        { ...market, observedAt: Date.now() - 5000 },
        crypto.randomUUID(),
        20_000_000n,
      ),
    ).toThrow();
    expect(() =>
      composePerpsOrder(
        perpsInstruction({ quantity: "1" }),
        perpsPolicy,
        market,
        crypto.randomUUID(),
        20_000_000n,
      ),
    ).toThrow();
    expect(() =>
      composePerpsOrder(
        perpsInstruction({ exits: { stopLossPrice: "5", takeProfitPrice: null, trailingStopBps: null } }),
        perpsPolicy,
        market,
        crypto.randomUUID(),
        20_000_000n,
      ),
    ).toThrow();
    expect(() =>
      composePerpsOrder(
        perpsInstruction({ leverage: 21 }),
        perpsPolicy,
        market,
        crypto.randomUUID(),
        20_000_000n,
      ),
    ).toThrow();
    expect(() =>
      composePerpsOrder(perpsInstruction(), perpsPolicy, market, crypto.randomUUID(), 100n),
    ).toThrow();
    expect(() =>
      composePerpsOrder(
        perpsInstruction(),
        perpsPolicy,
        {
          ...market,
          book: { ...market.book, levels: [market.book.levels[0], [{ px: "5", sz: "0.1", n: 1 }]] },
        },
        crypto.randomUUID(),
        20_000_000n,
      ),
    ).toThrow();
  });
  it("permits an owned position-reducing close with no free cash and rejects overselling", () => {
    const close = perpsInstruction({ action: "close", quantity: "2" });
    const result = composePerpsOrder(close, perpsPolicy, marketFixture(), crypto.randomUUID(), 0n, 200n);
    expect(result.maximumCashDebit).toBe(0n);
    if (result.action.type !== "order") {
      throw new Error("Missing close.");
    }
    expect(result.action.orders).toHaveLength(1);
    expect(result.action.orders[0]).toMatchObject({ r: true, b: false, s: "2" });
    expect(() =>
      composePerpsOrder(close, perpsPolicy, marketFixture(), crypto.randomUUID(), 0n, 199n),
    ).toThrow();
  });
  it("tightens long and short watermarks monotonically and never widens a replacement stop", () => {
    expect(tightenedPerpsStop("long", "4", "5", "6", 500, 2)).toEqual({ stop: "5.7", watermark: "6" });
    expect(tightenedPerpsStop("long", "5.7", "6", "5.8", 500, 2)).toEqual({ stop: "5.7", watermark: "6" });
    expect(tightenedPerpsStop("short", "6", "5", "4", 500, 2)).toEqual({ stop: "4.2", watermark: "4" });
    expect(() =>
      composePerpsProtection(perpsInstruction(), marketFixture(), crypto.randomUUID(), 200n, "3.9", 50),
    ).toThrow();
  });
});
