import { z } from "zod";

// The Portfolio Insights cards read these over GET /api/portfolio/insights. The browser parses each response with
// the same schema the types come from. Every figure is display-only.

export const INSIGHT_CARDS = ["spot", "perps", "memecoins"] as const;
export type InsightCard = (typeof INSIGHT_CARDS)[number];

/** Rows per list. */
export const INSIGHT_ROWS = 5;

const decimalText = z.string().regex(/^-?\d{1,30}(?:\.\d{1,18})?$/);

export const insightRowSchema = z.strictObject({
  key: z.string().max(260),
  symbol: z.string().max(160),
  icon: z
    .string()
    .max(300)
    .regex(/^https:\/\//)
    .nullable(),
  /** USD per whole token, as the provider gave it. */
  price: z.string().max(80).nullable(),
  /** USD, whole dollars. */
  volume24h: decimalText.nullable(),
  marketCap: decimalText.nullable(),
  /** Squint's risk grade; memecoins only. */
  verdict: z.enum(["clean", "caution", "danger"]).nullable(),
  /** Percent, two decimals. */
  change24h: decimalText.nullable(),
});
export type InsightRow = z.infer<typeof insightRowSchema>;

export const spotInsightSchema = z.strictObject({
  gainers: z.array(insightRowSchema).max(INSIGHT_ROWS),
  losers: z.array(insightRowSchema).max(INSIGHT_ROWS),
});
export type SpotInsight = z.infer<typeof spotInsightSchema>;

export const listInsightSchema = z.strictObject({
  rows: z.array(insightRowSchema).max(INSIGHT_ROWS),
});
export type ListInsight = z.infer<typeof listInsightSchema>;
