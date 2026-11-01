import "server-only";
import { z } from "zod";
import type { ResearchAssessment, ResearchItem, ResearchSource } from "@/shared/research";
import { compare, type Decimal, decimal, displayDecimal, percent, price, ratio, subtract } from "./decimal";
import type { PerpMarket } from "./hyperliquid";
import { marketJson } from "./market-http";

const HOUR = 3_600_000;
const value = z
  .string()
  .max(100)
  .refine((text) => {
    try {
      return decimal(text).n > 0n;
    } catch {
      return false;
    }
  }, "Positive exact price required");
export const candleSchema = z.object({
  t: z.coerce.number().int().positive(),
  T: z.coerce.number().int().positive(),
  s: z.string().max(60),
  i: z.literal("1h"),
  o: value,
  h: value,
  l: value,
  c: value,
  v: z.string().max(100),
});
export type MarketCandle = z.infer<typeof candleSchema>;

function mean(values: readonly Decimal[]): Decimal {
  let sum: Decimal = { n: 0n, d: 1n };
  for (const item of values) {
    let denominator = sum.d;
    if (item.d > denominator) {
      denominator = item.d;
    }
    sum = { n: sum.n * (denominator / sum.d) + item.n * (denominator / item.d), d: denominator };
  }
  return { n: sum.n, d: sum.d * BigInt(values.length) };
}

/** A disclosed deterministic technical screen, not a backtested prediction or execution rule. */
export function assessPerp(
  market: PerpMarket,
  candles: readonly MarketCandle[],
  now: number,
): { readonly assessment: ResearchAssessment; readonly item: ResearchItem } {
  const coin = market.market.name;
  const closed = [...candles]
    .filter((candle) => candle.T < Math.floor(now / HOUR) * HOUR)
    .sort((a, b) => a.t - b.t)
    .slice(-25);
  const last = closed.at(-1),
    first = closed[0],
    fourHoursAgo = closed.at(-5);
  const complete =
    closed.length === 25 &&
    closed.every(
      (candle, index) =>
        candle.s === coin &&
        candle.T === candle.t + HOUR - 1 &&
        (index === 0 || candle.t === (closed[index - 1]?.t ?? 0) + HOUR) &&
        compare(decimal(candle.h), decimal(candle.l)) >= 0 &&
        compare(decimal(candle.h), decimal(candle.c)) >= 0 &&
        compare(decimal(candle.l), decimal(candle.c)) <= 0,
    );
  const sourceId = `hl-candles:${coin}`;
  if (!last || !first || !fourHoursAgo || !complete || now - last.T > 90 * 60_000) {
    throw new Error("Fresh consecutive closed candles are required for a directional view.");
  }
  const close = decimal(last.c),
    average = mean(closed.slice(-20).map((candle) => decimal(candle.c)));
  const momentum4 = ratio(subtract(close, decimal(fourHoursAgo.c)), decimal(fourHoursAgo.c));
  const momentum24 = ratio(subtract(close, decimal(first.c)), decimal(first.c));
  const threshold = decimal("0.005");
  const long = compare(close, average) > 0 && compare(momentum4, threshold) >= 0 && momentum24.n > 0n;
  const short =
    compare(close, average) < 0 &&
    compare(momentum4, { n: -threshold.n, d: threshold.d }) <= 0 &&
    momentum24.n < 0n;
  const decision = long ? "lean_long" : short ? "lean_short" : "wait";
  const direction = long ? "above" : short ? "below" : "near or mixed around";
  const meanPrice = `$${displayDecimal(average, 8)}`;
  const summary = long
    ? `${coin}: lean long on the intraday technical screen; confirm execution costs and news before entry.`
    : short
      ? `${coin}: lean short on the intraday technical screen; confirm execution costs and news before entry.`
      : `${coin}: wait. The intraday trend/momentum screen does not support a clear side.`;
  const reasons = [
    `Last closed price ${price(last.c)} is ${direction} the 20-hour average ${meanPrice}.`,
    `Closed-candle move: ${percent(momentum4)} over 4 hours and ${percent(momentum24)} over 24 hours.`,
    `Current hourly funding is ${percent(decimal(market.context.funding))}; funding is a holding cost, not a direction signal.`,
  ];
  const conditions = [
    long
      ? `Long bias invalidates on an hourly close below the 20-hour average (currently ${meanPrice}).`
      : short
        ? `Short bias invalidates on an hourly close above the 20-hour average (currently ${meanPrice}).`
        : "Reassess when a 4-hour move of at least 0.5% agrees with both the 20-hour average and 24-hour direction.",
    "No position size, leverage or stop order is inferred. Costs, news, and the user's loss limit must be reviewed.",
  ];
  return {
    assessment: { decision, summary, reasons, conditions, sourceIds: [sourceId, "hyperliquid-perps"] },
    item: {
      id: `trend:${coin}`,
      title: `${coin} intraday technical analysis`,
      kind: "market",
      status: "indicative",
      metrics: [
        { label: "Technical bias", value: decision.replaceAll("_", " ") },
        { label: "Last closed price", value: price(last.c) },
        { label: "20-hour average", value: meanPrice },
        { label: "4-hour move", value: percent(momentum4) },
        { label: "24-hour move", value: percent(momentum24) },
        { label: "Candle close", value: new Date(last.T).toISOString() },
      ],
      note: "Uses 25 consecutive closed hourly candles. A 0.5% 4-hour momentum threshold plus trend agreement is a screening heuristic, not tested profitability or an instruction to trade.",
      sourceIds: [sourceId],
    },
  };
}

export async function perpAnalysis(
  market: PerpMarket,
  signal: AbortSignal,
): Promise<{
  readonly assessment: ResearchAssessment;
  readonly item: ResearchItem;
  readonly source: ResearchSource;
}> {
  const now = Date.now();
  const response = await marketJson("Hyperliquid price history", "https://api.hyperliquid.xyz/info", {
    body: {
      type: "candleSnapshot",
      req: { coin: market.market.name, interval: "1h", startTime: now - 30 * HOUR, endTime: now },
    },
    signal,
  });
  const candles = z.array(candleSchema).max(40).parse(response.value);
  return {
    ...assessPerp(market, candles, now),
    source: {
      id: `hl-candles:${market.market.name}`,
      label: `Hyperliquid ${market.market.name} closed hourly candles`,
      url: "https://app.hyperliquid.xyz/",
      observedAt: response.capturedAt,
    },
  };
}
