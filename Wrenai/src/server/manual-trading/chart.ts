import "server-only";
import { z } from "zod";
import { hlInfo } from "@/server/execution/hyperliquid/transport";
import { indicatorValue, technicalIndicators } from "@/server/research/indicators";

const bar = z.object({
  t: z.number().int().positive().safe(),
  T: z.number().int().positive().safe(),
  s: z.string(),
  i: z.literal("1h"),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
});
export interface MarketChartData {
  readonly bars: readonly { readonly at: number; readonly close: string }[];
  readonly indicators: readonly { readonly label: string; readonly value: string }[];
}
export async function marketChart(market: string): Promise<MarketChartData> {
  const ms = 3600000,
    end = Math.floor(Date.now() / ms) * ms - 1,
    start = end + 1 - ms * 600;
  const rows = z
    .array(bar)
    .max(650)
    .parse(
      await hlInfo({
        type: "candleSnapshot",
        req: { coin: market, interval: "1h", startTime: start, endTime: end },
      }),
    )
    .filter((b) => b.t >= start && b.T <= end);
  if (
    rows.length !== 600 ||
    rows.some((b, index) => b.s !== market || b.t !== start + index * ms || b.T !== b.t + ms - 1)
  ) {
    throw new Error("A complete hourly chart is unavailable for this market.");
  }
  const indicators = technicalIndicators(
    rows.map((b) => ({
      high: indicatorValue(b.h),
      low: indicatorValue(b.l),
      close: indicatorValue(b.c),
      volume: indicatorValue(b.v),
    })),
  );
  return {
    bars: rows.slice(-96).map((b) => ({ at: b.t, close: b.c })),
    indicators: [
      { label: "RSI 14", value: indicators.rsi14 },
      { label: "EMA 20", value: indicators.ema20 },
      { label: "EMA 50", value: indicators.ema50 },
      { label: "EMA 200", value: indicators.ema200 },
      { label: "MACD", value: indicators.macdHistogram },
      { label: "ATR 14", value: indicators.atr14 },
    ],
  };
}
