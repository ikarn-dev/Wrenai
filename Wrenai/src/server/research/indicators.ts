/** Fixed-point chart arithmetic. Indicators are research evidence, never executable order prices. */
export const INDICATOR_SCALE = 1_000_000_000_000n;
export interface TechnicalBar {
  readonly close: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly volume: bigint;
}
export function indicatorValue(text: string): bigint {
  if (!/^(?:0|[1-9]\d{0,20})(?:\.\d{1,24})?$/.test(text)) {
    throw new RangeError("Invalid chart decimal.");
  }
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * INDICATOR_SCALE + BigInt(fraction.padEnd(12, "0").slice(0, 12));
}
export function displayIndicator(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / INDICATOR_SCALE}.${(magnitude % INDICATOR_SCALE).toString().padStart(12, "0")}`.replace(
    /\.?0+$/,
    "",
  );
}
function mean(values: readonly bigint[]): bigint {
  if (!values.length) {
    throw new RangeError("An indicator needs observations.");
  }
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}
function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
function maximum(values: readonly bigint[]): bigint {
  if (!values.length) {
    throw new RangeError("A high needs observations.");
  }
  return values.reduce((max, value) => {
    if (value > max) {
      return value;
    }
    return max;
  });
}
function minimum(values: readonly bigint[]): bigint {
  return -maximum(values.map((value) => -value));
}
function squareRoot(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError("Negative variance.");
  }
  if (value < 2n) {
    return value;
  }
  let result = value,
    candidate = (value + 1n) / 2n;
  while (candidate < result) {
    result = candidate;
    candidate = (value / candidate + candidate) / 2n;
  }
  return result;
}
export function exponentialAverage(values: readonly bigint[], period: number): readonly bigint[] {
  if (values.length < period || period < 1) {
    throw new RangeError("Insufficient EMA warm-up.");
  }
  let current = mean(values.slice(0, period));
  const result = [current];
  for (const value of values.slice(period)) {
    current = (current * BigInt(period - 1) + value * 2n) / BigInt(period + 1);
    result.push(current);
  }
  return result;
}
function last(values: readonly bigint[]): bigint {
  const value = values.at(-1);
  if (value === undefined) {
    throw new RangeError("Missing indicator observation.");
  }
  return value;
}
function smoothed(values: readonly bigint[], period: number): readonly bigint[] {
  if (values.length < period) {
    throw new RangeError("Insufficient Wilder warm-up.");
  }
  let current = mean(values.slice(0, period));
  const result = [current];
  for (const value of values.slice(period)) {
    current = (current * BigInt(period - 1) + value) / BigInt(period);
    result.push(current);
  }
  return result;
}
export interface TechnicalIndicators {
  readonly ema20: string;
  readonly ema50: string;
  readonly ema200: string;
  readonly rsi14: string;
  readonly macd: string;
  readonly macdSignal: string;
  readonly macdHistogram: string;
  readonly atr14: string;
  readonly adx14: string;
  readonly bollingerMiddle: string;
  readonly bollingerUpper: string;
  readonly bollingerLower: string;
  readonly vwap20: string | null;
  readonly volumeChangePercent: string | null;
  readonly swingHigh20: string;
  readonly swingLow20: string;
  readonly close: string;
}
export function technicalIndicators(bars: readonly TechnicalBar[]): TechnicalIndicators {
  if (
    bars.length < 600 ||
    bars.some(
      (bar) =>
        bar.close <= 0n ||
        bar.volume < 0n ||
        bar.low <= 0n ||
        bar.high < bar.low ||
        bar.close > bar.high ||
        bar.close < bar.low,
    )
  ) {
    throw new RangeError("At least 600 valid closed bars are required.");
  }
  const closes = bars.map((bar) => bar.close);
  const gains: bigint[] = [],
    losses: bigint[] = [],
    ranges: bigint[] = [],
    plus: bigint[] = [],
    minus: bigint[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i],
      previous = bars[i - 1];
    if (!bar || !previous) {
      throw new RangeError("A chart bar is missing.");
    }
    const change = bar.close - previous.close;
    gains.push(change > 0n ? change : 0n);
    losses.push(change < 0n ? -change : 0n);
    ranges.push(
      maximum([bar.high - bar.low, absolute(bar.high - previous.close), absolute(bar.low - previous.close)]),
    );
    const up = bar.high - previous.high,
      down = previous.low - bar.low;
    plus.push(up > down && up > 0n ? up : 0n);
    minus.push(down > up && down > 0n ? down : 0n);
  }
  const gain = last(smoothed(gains, 14)),
    loss = last(smoothed(losses, 14));
  const rsi = gain + loss === 0n ? 50n * INDICATOR_SCALE : (100n * INDICATOR_SCALE * gain) / (gain + loss);
  const tr = smoothed(ranges, 14),
    positive = smoothed(plus, 14),
    negative = smoothed(minus, 14);
  const dx = tr.map((range, index) => {
    const up = positive[index],
      down = negative[index];
    if (up === undefined || down === undefined) {
      throw new RangeError("Incomplete directional series.");
    }
    return range === 0n || up + down === 0n
      ? 0n
      : (100n * INDICATOR_SCALE * absolute(up - down)) / (up + down);
  });
  const fast = exponentialAverage(closes, 12),
    slow = exponentialAverage(closes, 26);
  const macd = slow.map((value, index) => {
    const quick = fast[index + 14];
    if (quick === undefined) {
      throw new RangeError("Incomplete MACD series.");
    }
    return quick - value;
  });
  const signal = last(exponentialAverage(macd, 9));
  const recent = bars.slice(-20),
    middle = mean(recent.map((bar) => bar.close));
  const deviation = squareRoot(mean(recent.map((bar) => (bar.close - middle) ** 2n)));
  const volume = recent.reduce((sum, bar) => sum + bar.volume, 0n);
  const previousVolume = bars.slice(-40, -20).reduce((sum, bar) => sum + bar.volume, 0n);
  const weighted = recent.reduce(
    (sum, bar) => sum + ((bar.high + bar.low + bar.close) * bar.volume) / 3n,
    0n,
  );
  return {
    ema20: displayIndicator(last(exponentialAverage(closes, 20))),
    ema50: displayIndicator(last(exponentialAverage(closes, 50))),
    ema200: displayIndicator(last(exponentialAverage(closes, 200))),
    rsi14: displayIndicator(rsi),
    macd: displayIndicator(last(macd)),
    macdSignal: displayIndicator(signal),
    macdHistogram: displayIndicator(last(macd) - signal),
    atr14: displayIndicator(last(tr)),
    adx14: displayIndicator(last(smoothed(dx, 14))),
    bollingerMiddle: displayIndicator(middle),
    bollingerUpper: displayIndicator(middle + 2n * deviation),
    bollingerLower: displayIndicator(middle - 2n * deviation),
    vwap20: volume === 0n ? null : displayIndicator(weighted / volume),
    volumeChangePercent:
      previousVolume === 0n
        ? null
        : displayIndicator((100n * INDICATOR_SCALE * (volume - previousVolume)) / previousVolume),
    swingHigh20: displayIndicator(maximum(recent.map((bar) => bar.high))),
    swingLow20: displayIndicator(minimum(recent.map((bar) => bar.low))),
    close: displayIndicator(last(closes)),
  };
}
