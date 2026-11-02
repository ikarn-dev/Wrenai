import "server-only";
import { z } from "zod";
import {
  type MarketTechnical,
  marketTechnicalSchema,
  type ResearchAssessment,
  type ResearchItem,
  type ResearchSource,
} from "@/shared/research";
import type { PerpMarket } from "./hyperliquid";
import { displayIndicator, indicatorValue, technicalIndicators } from "./indicators";
import { marketJson } from "./market-http";

const periods = [
  { interval: "15m", ms: 900_000 },
  { interval: "1h", ms: 3_600_000 },
  { interval: "4h", ms: 14_400_000 },
] as const;
const text = z.string().min(1).max(100);
const candle = z.object({
  t: z.coerce.number().int().positive().safe(),
  T: z.coerce.number().int().positive().safe(),
  s: z.string().max(60),
  i: z.enum(["15m", "1h", "4h"]),
  o: text,
  h: text,
  l: text,
  c: text,
  v: text,
});
async function frame(
  market: string,
  period: (typeof periods)[number],
  now: number,
  signal: AbortSignal,
): Promise<MarketTechnical["frames"][number]> {
  const end = Math.floor(now / period.ms) * period.ms - 1;
  const start = end + 1 - period.ms * 600;
  const response = await marketJson("Hyperliquid closed candles", "https://api.hyperliquid.xyz/info", {
    body: {
      type: "candleSnapshot",
      req: { coin: market, interval: period.interval, startTime: start, endTime: end },
    },
    cacheMs: 15_000,
    signal,
  });
  const bars = z
    .array(candle)
    .max(5000)
    .parse(response.value)
    .filter((bar) => bar.t >= start && bar.T <= end);
  if (
    bars.length !== 600 ||
    bars.some(
      (bar, index) =>
        bar.s !== market ||
        bar.i !== period.interval ||
        bar.t !== start + index * period.ms ||
        bar.T !== bar.t + period.ms - 1,
    )
  ) {
    throw new Error("Fresh consecutive closed candles are required for every timeframe.");
  }
  const values = bars.map((bar) => {
    const high = indicatorValue(bar.h),
      low = indicatorValue(bar.l),
      open = indicatorValue(bar.o);
    if (open < low || open > high) {
      throw new Error("A candle's open is outside its range.");
    }
    return { high, low, close: indicatorValue(bar.c), volume: indicatorValue(bar.v) };
  });
  return {
    interval: period.interval,
    sampleCount: 600,
    firstBarAt: start,
    lastBarAt: end,
    indicators: technicalIndicators(values),
  };
}
function signed(text: string): bigint {
  return text.startsWith("-") ? -indicatorValue(text.slice(1)) : indicatorValue(text);
}
function frameScore(frame: MarketTechnical["frames"][number]): number {
  const i = frame.indicators;
  let score = 0;
  const e20 = indicatorValue(i.ema20),
    e50 = indicatorValue(i.ema50),
    e200 = indicatorValue(i.ema200),
    close = indicatorValue(i.close);
  if (close > e20 && e20 > e50) {
    score += 2;
  }
  if (close < e20 && e20 < e50) {
    score -= 2;
  }
  if (close > e200) {
    score += 1;
  } else if (close < e200) {
    score -= 1;
  }
  if (signed(i.macdHistogram) > 0n) {
    score += 1;
  } else if (signed(i.macdHistogram) < 0n) {
    score -= 1;
  }
  const rsi = indicatorValue(i.rsi14);
  if (rsi > indicatorValue("50") && rsi < indicatorValue("75")) {
    score += 1;
  }
  if (rsi < indicatorValue("50") && rsi > indicatorValue("25")) {
    score -= 1;
  }
  return score;
}
export function assessTechnicalFrames(
  technical: MarketTechnical,
  sourceIds: readonly string[],
): ResearchAssessment {
  const scores = technical.frames.map(frameScore);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const setup = technical.frames.find((f) => f.interval === "1h");
  if (!setup) {
    throw new Error("A setup timeframe is required.");
  }
  const decision = total > 0 ? "lean_long" : total < 0 ? "lean_short" : "wait";
  const agree = scores.filter((score) => (decision === "lean_long" ? score > 0 : score < 0)).length;
  const strength = agree === 3 && Math.abs(total) >= 9 ? "strong" : agree >= 2 ? "moderate" : "weak";
  const i = setup.indicators;
  const close = indicatorValue(i.close),
    atr = indicatorValue(i.atr14),
    low = indicatorValue(i.swingLow20),
    high = indicatorValue(i.swingHigh20);
  const lowStop = close - 2n * atr;
  const highStop = close + 2n * atr;
  let stop = decision === "lean_long" ? lowStop : highStop;
  if (decision === "lean_long" && low < stop) {
    stop = low;
  }
  if (decision !== "lean_long" && high > stop) {
    stop = high;
  }
  const risk = decision === "lean_long" ? close - stop : stop - close;
  const target = decision === "lean_long" ? close + 2n * risk : close - 2n * risk;
  const conditions =
    decision !== "wait" && stop > 0n && target > 0n && risk > 0n
      ? [
          `Conditional setup anchored to the last closed 1h price ${i.close}; protective invalidation ${displayIndicator(stop)} and illustrative 2R target ${displayIndicator(target)}. These are chart-derived hypotheses, not submitted orders or guaranteed fills.`,
          `Recheck current price, fees, funding, relevant news and the user's loss limit before an entry; disagreement with the 4h regime weakens the setup.`,
        ]
      : [
          "The closed-bar frames do not establish a priced directional setup; obtain a new validated frame before preparing any order.",
        ];
  return {
    decision,
    summary:
      decision === "wait"
        ? `${technical.market}: balanced technical scores; no directional ranking from these frames.`
        : `${technical.market}: ${strength} ${decision === "lean_long" ? "long" : "short"} bias across 15m/1h/4h closed-bar evidence.`,
    reasons: [
      `Directional scores (not probabilities): 15m ${scores[0]}, 1h ${scores[1]}, 4h ${scores[2]}; combines EMA trend/regime, MACD histogram and RSI.`,
      `1h RSI14 ${i.rsi14}, ADX14 ${i.adx14}, ATR14 ${i.atr14}; supported VWAP and volume changes are included in each frame.`,
      `Contrary evidence: ${agree < 3 ? "at least one timeframe does not agree with the leading side" : "trend agreement cannot rule out exhaustion, a reversal or an adverse news event"}. Funding alone is not a directional signal.`,
    ],
    conditions,
    sourceIds: [...sourceIds],
  };
}
export async function perpTechnicalAnalysis(
  market: PerpMarket,
  signal: AbortSignal,
): Promise<{
  readonly item: ResearchItem;
  readonly technical: MarketTechnical;
  readonly assessment: ResearchAssessment;
  readonly sources: readonly ResearchSource[];
}> {
  const now = Date.now();
  const frames = await Promise.all(periods.map((period) => frame(market.market.name, period, now, signal)));
  const technical = marketTechnicalSchema.parse({ market: market.market.name, frames });
  const sources: ResearchSource[] = frames.map((frame) => ({
    id: `hl-chart:${technical.market}:${frame.interval}`,
    label: `Hyperliquid ${technical.market} ${frame.interval} closed candles`,
    url: "https://app.hyperliquid.xyz/trade",
    observedAt: now,
  }));
  const assessment = assessTechnicalFrames(
    technical,
    sources.map((source) => source.id),
  );
  return {
    technical,
    assessment,
    sources,
    item: {
      id: `technical:${technical.market}`,
      title: `${technical.market} · 15m / 1h / 4h`,
      kind: "market",
      status: "indicative",
      metrics: [
        { label: "Technical view", value: assessment.summary },
        ...frames.map((frame) => ({
          label: `${frame.interval} trend`,
          value: `EMA20 ${frame.indicators.ema20}; EMA50 ${frame.indicators.ema50}; EMA200 ${frame.indicators.ema200}; RSI ${frame.indicators.rsi14}`,
        })),
      ],
      note: "600 consecutive closed candles per frame. Indicator values are deterministic research, not measured predictive accuracy. Volume-weighted prices use candle typical prices, not tick order flow.",
      sourceIds: sources.map((source) => source.id),
    },
  };
}
