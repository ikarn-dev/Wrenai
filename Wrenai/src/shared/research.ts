import { z } from "zod";
import { agentTokenBudgetSchema } from "./agent-budget";

// Retired entries are history metadata only. Active requests use the separate eight-family allowlist.
export const RESEARCH_TOOLS = {
  spot_trader: {
    label: "Spot Trader",
    description:
      "Research exact spot buy/sell quotes and profit-taking rules for supported assets. Never submit orders from chat.",
  },
  dca: {
    label: "DCA",
    description:
      "Research a scheduled spot purchase pair and costs. Scheduling needs a separately reviewed agent.",
  },
  whale_tracker: {
    label: "Whale / Smart Money Tracker",
    description:
      "Inspect confirmed public movements for an explicit watched account. Large transfers alone do not establish profitable smart money.",
  },
  buy_the_dip: {
    label: "Buy the Dip",
    description:
      "Research spot entry quotes and a user's explicit dip reference, threshold and budget; no automatic trade from chat.",
  },
  sell_the_top: {
    label: "Sell the Top",
    description:
      "Research spot exit quotes for user-defined net-profit targets and confirmed cost basis. Never claim to predict the market top.",
  },
  rebalancer: {
    label: "Rebalancer",
    description:
      "Read supported asset prices and account allocation data; explain rebalancing without trading.",
  },
  triggers: {
    label: "Triggers / DCA",
    description:
      "Read current markets and dry swap quotes for entry, exit and DCA research; never place orders.",
  },
  copy_trading: {
    label: "Copy Trading",
    description: "Read public leader activity and account data. Never copy or submit a trade.",
  },
  yield_optimizer: {
    label: "Yield Optimizer",
    description:
      "Compare live lending, liquid staking and available Earn instruments with sources and withdrawal constraints.",
  },
  meme_hunter: {
    label: "Meme Hunter",
    description:
      "Discover live NEAR meme-token markets, liquidity and available launch information. Never call a token safe.",
  },
  private_payments: {
    label: "Private Payments",
    description:
      "Validate public recipient/token information and research payment requirements; never send funds.",
  },
  lp_manager: {
    label: "LP Manager",
    description:
      "Research live NEAR liquidity pools, fee tiers and liquidity. Explain ranges and risks without changing positions.",
  },
  lending_margin: {
    label: "Lending / Margin",
    description:
      "Read RHEA lending markets, supply/borrow availability and public account information; never borrow or repay.",
  },
  perps: {
    label: "Perps",
    description:
      "Read live Hyperliquid perpetual prices, funding and depth; no orders, leverage changes or account authorization.",
  },
  arbitrage: {
    label: "Arbitrage",
    description:
      "Scan actual pool round-trip quotes, staking discounts, spot/perp basis and funding. Distinguish gross/indicative spreads from net executable arbitrage.",
  },
} as const;

export const researchToolSchema = z.enum([
  "spot_trader",
  "dca",
  "whale_tracker",
  "buy_the_dip",
  "sell_the_top",
  "rebalancer",
  "triggers",
  "copy_trading",
  "yield_optimizer",
  "meme_hunter",
  "private_payments",
  "lp_manager",
  "lending_margin",
  "perps",
  "arbitrage",
]);
export type ResearchTool = z.infer<typeof researchToolSchema>;
const asset = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:@-]+$/);
export const researchInputSchema = z.strictObject({
  symbols: z.array(asset).max(6).default([]),
  amount: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,24})?$/)
    .optional(),
  amountAsset: asset.optional(),
  accountId: z
    .string()
    .min(2)
    .max(64)
    .regex(/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*|0x[a-fA-F0-9]{40})$/)
    .optional(),
  poolId: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
});
export type ResearchInput = z.infer<typeof researchInputSchema>;

export const researchSourceSchema = z.strictObject({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(100),
  url: z.url({ protocol: /^https$/ }),
  observedAt: z.number().int().positive(),
  blockHeight: z.number().int().positive().optional(),
});
export const researchItemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(160),
  kind: z.enum(["market", "quote", "opportunity", "protocol", "account"]),
  status: z.enum(["observed", "indicative", "quoted", "no_edge"]),
  metrics: z
    .array(z.strictObject({ label: z.string().min(1).max(80), value: z.string().min(1).max(300) }))
    .max(10),
  note: z.string().max(500),
  sourceIds: z.array(z.string()).max(6),
});
export const researchNewsSchema = z.strictObject({
  status: z.enum(["ok", "partial", "unavailable", "not_configured"]),
  query: z.string().max(400),
  searchedAt: z.number().int().positive(),
  articles: z
    .array(
      z.strictObject({
        id: z.string().max(80),
        title: z.string().max(200),
        url: z.url({ protocol: /^https$/ }),
        snippet: z.string().max(500),
        pageDate: z.number().int().positive().nullable(),
      }),
    )
    .max(5),
  note: z.string().max(400),
});
export type ResearchNews = z.infer<typeof researchNewsSchema>;

export const researchAssessmentSchema = z.strictObject({
  decision: z.enum(["lean_long", "lean_short", "wait", "compare", "needs_input"]),
  summary: z.string().max(400),
  reasons: z.array(z.string().max(300)).max(4),
  conditions: z.array(z.string().max(300)).max(4),
  sourceIds: z.array(z.string().max(80)).max(6),
});
export type ResearchAssessment = z.infer<typeof researchAssessmentSchema>;

const indicatorText = z.string().min(1).max(100);
export const marketTechnicalSchema = z.strictObject({
  market: z.string().min(1).max(60),
  frames: z
    .array(
      z.strictObject({
        interval: z.enum(["15m", "1h", "4h"]),
        sampleCount: z.literal(600),
        firstBarAt: z.number().int().positive(),
        lastBarAt: z.number().int().positive(),
        indicators: z.strictObject({
          ema20: indicatorText,
          ema50: indicatorText,
          ema200: indicatorText,
          rsi14: indicatorText,
          macd: indicatorText,
          macdSignal: indicatorText,
          macdHistogram: indicatorText,
          atr14: indicatorText,
          adx14: indicatorText,
          bollingerMiddle: indicatorText,
          bollingerUpper: indicatorText,
          bollingerLower: indicatorText,
          vwap20: indicatorText.nullable(),
          volumeChangePercent: indicatorText.nullable(),
          swingHigh20: indicatorText,
          swingLow20: indicatorText,
          close: indicatorText,
        }),
      }),
    )
    .length(3),
});
export type MarketTechnical = z.infer<typeof marketTechnicalSchema>;

export const researchReportSchema = z.strictObject({
  tool: researchToolSchema,
  status: z.enum(["ok", "partial", "unavailable"]),
  summary: z.string().min(1).max(600),
  observedAt: z.number().int().positive(),
  items: z.array(researchItemSchema).max(12),
  sources: z.array(researchSourceSchema).max(20),
  limitations: z.array(z.string().max(300)).max(5),
  assessment: researchAssessmentSchema.optional(),
  news: researchNewsSchema.optional(),
  technicals: z.array(marketTechnicalSchema).max(6).optional(),
});
export type ResearchReport = z.infer<typeof researchReportSchema>;
export type ResearchItem = z.infer<typeof researchItemSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const agentSetupDraftSchema = z.strictObject({
  id: z.uuid(),
  tool: researchToolSchema,
  brief: z.string().min(1).max(4_000),
  briefTruncated: z.boolean().optional(),
  reviewState: z.enum(["draft", "reviewed"]).optional(),
  budget: agentTokenBudgetSchema.optional(),
  agentId: z.uuid().optional(),
  reports: z.array(researchReportSchema).max(6),
  createdAt: z.number().int().positive(),
});
export type AgentSetupDraft = z.infer<typeof agentSetupDraftSchema>;
