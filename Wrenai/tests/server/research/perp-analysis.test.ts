import { describe, expect, it, vi } from "vitest";
import type { PerpMarket } from "@/server/research/hyperliquid";
import { assessPerp, type MarketCandle } from "@/server/research/perp-analysis";

vi.mock("server-only", () => ({}));
const HOUR = 3600000,
  now = 1800000000000;
const market: PerpMarket = {
  market: { name: "NEAR", szDecimals: 2, maxLeverage: 10 },
  context: { markPx: "10", funding: "0.0001", openInterest: "1", dayNtlVlm: "1000000" },
};
function candles(direction: "up" | "down" | "flat"): MarketCandle[] {
  return Array.from({ length: 25 }, (_, index) => {
    const t = Math.floor(now / HOUR) * HOUR - (25 - index) * HOUR;
    const value = direction === "up" ? 100 + index : direction === "down" ? 125 - index : 100;
    return {
      t,
      T: t + HOUR - 1,
      s: "NEAR",
      i: "1h",
      o: String(value),
      c: String(value),
      h: String(value + 1),
      l: String(value - 1),
      v: "100",
    };
  });
}
describe("market-side evidence screen", () => {
  it("gives long/short only when price, four-hour momentum and day direction agree", () => {
    expect(assessPerp(market, candles("up"), now).assessment.decision).toBe("lean_long");
    expect(assessPerp(market, candles("down"), now).assessment.decision).toBe("lean_short");
    expect(assessPerp(market, candles("flat"), now).assessment.decision).toBe("wait");
    expect(
      assessPerp({ ...market, context: { ...market.context, funding: "-0.0001" } }, candles("up"), now)
        .assessment.decision,
    ).toBe("lean_long");
    expect(assessPerp(market, candles("up"), now).assessment.conditions.join(" ")).toContain("invalidates");
  });
  it("refuses stale, gapped or wrong-market candles instead of inventing a side", () => {
    const fresh = candles("up");
    expect(() => assessPerp(market, fresh, now + 3 * HOUR)).toThrow("Fresh consecutive");
    expect(() => assessPerp(market, fresh.slice(1), now)).toThrow("Fresh consecutive");
    expect(() =>
      assessPerp(
        market,
        fresh.map((candle) => ({ ...candle, s: "BTC" })),
        now,
      ),
    ).toThrow("Fresh consecutive");
  });
});
