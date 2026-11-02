import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PerpMarket } from "@/server/research/hyperliquid";
import { INDICATOR_SCALE, technicalIndicators } from "@/server/research/indicators";
import { marketJson } from "@/server/research/market-http";
import { assessTechnicalFrames, perpTechnicalAnalysis } from "@/server/research/perp-technicals";
import type { MarketTechnical } from "@/shared/research";

vi.mock("server-only", () => ({}));
vi.mock("@/server/research/market-http", () => ({ marketJson: vi.fn() }));
const now = Date.parse("2026-11-02T00:00:00Z");
const market: PerpMarket = {
  market: { name: "NEAR", szDecimals: 2, maxLeverage: 10 },
  context: { markPx: "699", funding: "0.0001", openInterest: "1", dayNtlVlm: "1000000" },
};
function technical(direction: "up" | "down" | "flat"): MarketTechnical {
  const bars = Array.from({ length: 600 }, (_, i) => {
    const value = BigInt(direction === "up" ? i + 100 : direction === "down" ? 800 - i : 100);
    return {
      close: value * INDICATOR_SCALE,
      high: (value + 1n) * INDICATOR_SCALE,
      low: (value - 1n) * INDICATOR_SCALE,
      volume: INDICATOR_SCALE,
    };
  });
  const indicators = technicalIndicators(bars);
  return {
    market: "NEAR",
    frames: ["15m", "1h", "4h"].map((interval) => ({
      interval: z.enum(["15m", "1h", "4h"]).parse(interval),
      sampleCount: 600,
      firstBarAt: now - 600 * 3600_000,
      lastBarAt: now - 1,
      indicators,
    })),
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(marketJson)
    .mockReset()
    .mockImplementation(async (_name, _url, options) => {
      const body = z
        .object({
          req: z.object({
            coin: z.string(),
            interval: z.enum(["15m", "1h", "4h"]),
            startTime: z.number(),
            endTime: z.number(),
          }),
        })
        .parse(options?.body);
      const period = (body.req.endTime + 1 - body.req.startTime) / 600;
      return {
        capturedAt: now,
        value: Array.from({ length: 600 }, (_, i) => ({
          t: body.req.startTime + i * period,
          T: body.req.startTime + (i + 1) * period - 1,
          s: body.req.coin,
          i: body.req.interval,
          o: String(i + 100),
          h: String(i + 101),
          l: String(i + 99),
          c: String(i + 100),
          v: "100",
        })),
      };
    });
});
afterEach(() => vi.restoreAllMocks());
describe("multi-timeframe directional evidence", () => {
  it("ranks long and short with explicit conditions, without claiming win probabilities", () => {
    expect(assessTechnicalFrames(technical("up"), ["chart"]).decision).toBe("lean_long");
    expect(assessTechnicalFrames(technical("down"), ["chart"]).decision).toBe("lean_short");
    expect(assessTechnicalFrames(technical("flat"), ["chart"]).decision).toBe("wait");
    expect(assessTechnicalFrames(technical("up"), ["chart"]).conditions.join(" ")).toContain("invalidation");
  });
  it("reads and validates 600 consecutive closed candles in every requested frame", async () => {
    const result = await perpTechnicalAnalysis(market, new AbortController().signal);
    expect(result.technical.frames.map((frame) => frame.interval)).toEqual(["15m", "1h", "4h"]);
    expect(
      result.technical.frames.every((frame) => frame.sampleCount === 600 && frame.lastBarAt === now - 1),
    ).toBe(true);
    expect(result.assessment.decision).toBe("lean_long");
    expect(result.sources).toHaveLength(3);
  });
  it("refuses incomplete or unrelated candles instead of inventing a side", async () => {
    vi.mocked(marketJson).mockResolvedValue({ capturedAt: now, value: [] });
    await expect(perpTechnicalAnalysis(market, new AbortController().signal)).rejects.toThrow(/consecutive/);
  });
});
