import { describe, expect, it } from "vitest";
import {
  displayIndicator,
  INDICATOR_SCALE,
  indicatorValue,
  technicalIndicators,
} from "@/server/research/indicators";

describe("closed-candle technical evidence", () => {
  it("handles flat markets without false momentum, volatility or volume claims", () => {
    const bars = Array.from({ length: 600 }, () => ({
      close: 100n * INDICATOR_SCALE,
      high: 100n * INDICATOR_SCALE,
      low: 100n * INDICATOR_SCALE,
      volume: 0n,
    }));
    expect(technicalIndicators(bars)).toMatchObject({
      ema20: "100",
      ema50: "100",
      ema200: "100",
      rsi14: "50",
      macd: "0",
      macdHistogram: "0",
      adx14: "0",
      atr14: "0",
      bollingerUpper: "100",
      bollingerLower: "100",
      vwap20: null,
      volumeChangePercent: null,
    });
  });
  it("produces coherent trend, range and volume indicators from a monotone series", () => {
    const bars = Array.from({ length: 600 }, (_, i) => ({
      close: BigInt(i + 100) * INDICATOR_SCALE,
      high: BigInt(i + 101) * INDICATOR_SCALE,
      low: BigInt(i + 99) * INDICATOR_SCALE,
      volume: INDICATOR_SCALE,
    }));
    const result = technicalIndicators(bars);
    expect(result.rsi14).toBe("100");
    expect(result.adx14).toBe("100");
    expect(result.atr14).toBe("2");
    expect(indicatorValue(result.ema20)).toBeGreaterThan(indicatorValue(result.ema50));
    expect(indicatorValue(result.ema50)).toBeGreaterThan(indicatorValue(result.ema200));
    expect(result.volumeChangePercent).toBe("0");
    expect(result.swingHigh20).toBe("700");
    expect(result.swingLow20).toBe("679");
  });
  it("rejects incomplete or malformed chart data and formats signed values", () => {
    expect(() => technicalIndicators([])).toThrow();
    expect(() => indicatorValue("NaN")).toThrow();
    expect(displayIndicator(-indicatorValue("0.125"))).toBe("-0.125");
    const invalid = Array.from({ length: 600 }, () => ({ close: 5n, high: 4n, low: 1n, volume: 1n }));
    expect(() => technicalIndicators(invalid)).toThrow();
  });
});
