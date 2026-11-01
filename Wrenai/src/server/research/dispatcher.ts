import "server-only";
import { z } from "zod";
import type { ChatToolDefinition } from "@/server/ai/verified-chat-stream";
import {
  RESEARCH_TOOLS,
  type ResearchInput,
  type ResearchReport,
  type ResearchTool,
  researchInputSchema,
  researchReportSchema,
  researchToolSchema,
} from "@/shared/research";
import { researchInputIssue } from "@/shared/research-input";
import { leaderResearch, memeResearch, paymentResearch } from "./accounts-launches";
import { arbitrageScan } from "./arbitrage";
import { DECISION_GUIDANCE } from "./decision-guidance";
import { perpBook, perpMarkets } from "./hyperliquid";
import { drySwapQuote, intentTokens, tokenPriceItems } from "./intents";
import { researchNews } from "./news";
import { perpAnalysis } from "./perp-analysis";
import { poolItems, rheaPools } from "./rhea";
import { lendingMarkets, stakingReadings } from "./staking-lending";

export const RESEARCH_DEFINITIONS: readonly ChatToolDefinition[] = Object.entries(RESEARCH_TOOLS).map(
  ([tool, info]) => ({
    type: "function",
    function: {
      name: `research_${tool}`,
      description: `${info.description} ${DECISION_GUIDANCE[researchToolSchema.parse(tool)]} Use this tool for current/live requests in this category. Public data only; accountId must be explicitly provided. Amounts are decimal strings with amountAsset identifying the unit; omitted amount means a labeled sample, not a user budget.`,
      parameters: z.toJSONSchema(researchInputSchema, { unrepresentable: "any" }),
      strict: false,
    },
  }),
);

async function toolReport(
  tool: ResearchTool,
  input: ResearchInput,
  signal: AbortSignal,
): Promise<
  Omit<ResearchReport, "items" | "sources" | "limitations"> & {
    readonly items: readonly ResearchReport["items"][number][];
    readonly sources: readonly ResearchReport["sources"][number][];
    readonly limitations: readonly string[];
  }
> {
  const base = { tool, observedAt: Date.now(), status: "ok" as const, limitations: [] };
  switch (tool) {
    case "arbitrage":
      return { ...base, ...(await arbitrageScan(input, signal)) };
    case "perps": {
      const data = await perpMarkets(input.symbols, signal);
      const first = data.markets[0];
      const [book, trend] = await Promise.allSettled([
        first ? perpBook(first.market.name, signal) : Promise.reject(new Error("No market")),
        first ? perpAnalysis(first, signal) : Promise.reject(new Error("No market")),
      ]);
      return {
        ...base,
        status: trend.status === "fulfilled" ? "ok" : "partial",
        summary:
          "Analyze the closed-candle trend together with live funding and available book liquidity. Give long/short/wait with reasons and invalidation; funding alone does not establish direction.",
        items: [
          ...(trend.status === "fulfilled" ? [trend.value.item] : []),
          ...data.items,
          ...(book.status === "fulfilled" ? [book.value] : []),
        ],
        sources: [data.source, ...(trend.status === "fulfilled" ? [trend.value.source] : [])],
        assessment:
          trend.status === "fulfilled"
            ? trend.value.assessment
            : {
                decision: "wait",
                summary:
                  "Price history could not be validated; no directional technical signal is established.",
                reasons: ["A current mark/funding snapshot alone is insufficient to choose long or short."],
                conditions: ["Obtain fresh consecutive closed candles before choosing a side."],
                sourceIds: [data.source.id],
              },
        limitations: book.status === "fulfilled" ? [] : ["Order-book liquidity was unavailable."],
      };
    }

    case "lp_manager": {
      const data = await rheaPools(signal);
      const pools = input.poolId ? data.pools.filter((pool) => pool.id === input.poolId) : data.pools;
      return {
        ...base,
        summary:
          "Current RHEA pool liquidity and fee tiers. LP ownership, accrued rewards and range profitability are not inferred from aggregate pool data.",
        items: poolItems(pools, input.symbols),
        sources: [data.source],
      };
    }
    case "meme_hunter":
      return { ...base, ...(await memeResearch(input, signal)) };
    case "lending_margin":
      return {
        ...base,
        summary:
          "Current RHEA protocol supply/borrow APR fields and eligibility flags, excluding farming incentives. Account liquidation health requires separate verified positions/oracles.",
        ...(await lendingMarkets(input, signal)),
      };
    case "yield_optimizer": {
      const [lending, staking, registry] = await Promise.allSettled([
        lendingMarkets(input, signal),
        stakingReadings(signal),
        intentTokens(signal),
      ]);
      const items = [
        ...(lending.status === "fulfilled" ? lending.value.items : []),
        ...(staking.status === "fulfilled" ? staking.value.map((item) => item.item) : []),
      ];
      const sources = [
        ...(lending.status === "fulfilled" ? lending.value.sources : []),
        ...(staking.status === "fulfilled" ? staking.value.map((item) => item.source) : []),
      ];
      if (registry.status === "fulfilled") {
        const receipts = registry.value.tokens.filter((token) =>
          ["gtUSDCp", "TLO", "kV-gtSOLb"].includes(token.symbol),
        );
        for (const token of receipts.slice(0, 3)) {
          items.push({
            id: token.assetId,
            title: `Earn receipt · ${token.symbol}`,
            kind: "protocol",
            status: "observed",
            metrics: [
              { label: "Chain", value: token.blockchain },
              { label: "Current registry", value: "Listed" },
            ],
            note: "Listed receipt token only; live deposit/withdraw quotes and protocol APY must be checked separately.",
            sourceIds: [registry.value.source.id],
          });
        }
        sources.push(registry.value.source);
      }
      return {
        ...base,
        status: items.length ? "partial" : "unavailable",
        summary:
          "Retrieved available RHEA APRs, liquid-staking redemption/liquidity state and currently listed Earn receipts. Do not treat exchange rates as APY or compare unlike return fields.",
        items: items.slice(0, 12),
        sources: sources.slice(0, 20),
        limitations: [
          "Staking APYs, incentive valuation, entry/exit costs and future rate changes are not fully established.",
        ],
      };
    }
    case "private_payments":
      return { ...base, ...(await paymentResearch(input, signal)) };
    case "copy_trading":
      return { ...base, ...(await leaderResearch(input, signal)) };
    case "triggers": {
      const data = await drySwapQuote(input, signal);
      return {
        ...base,
        summary:
          "A fresh dry swap preview for the requested pair/amount. A trigger/DCA agent still needs explicit entry/schedule/exit rules and user-reviewed limits.",
        items: [data.item],
        sources: [...data.sources],
      };
    }
    case "rebalancer": {
      const data = await intentTokens(signal);
      return {
        ...base,
        summary:
          "Supported asset reference prices for allocation research. No wallet holdings, drift or target allocation is assumed; request those details before making a rebalance plan.",
        items: tokenPriceItems(data.tokens, input.symbols),
        sources: [data.source],
      };
    }
    default: {
      const unhandled: never = tool;
      throw new Error(`Unsupported research tool: ${String(unhandled)}`);
    }
  }
}

export async function runResearchTool(
  name: string,
  rawArguments: string,
  signal: AbortSignal,
): Promise<ResearchReport> {
  const tool = researchToolSchema.parse(name.startsWith("research_") ? name.slice("research_".length) : name);
  const parsed = researchInputSchema.safeParse(
    (() => {
      try {
        return JSON.parse(rawArguments);
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success) {
    return {
      tool,
      status: "unavailable",
      summary:
        "Required research inputs could not be validated. Ask for the missing public asset/account or amount unit.",
      observedAt: Date.now(),
      items: [],
      sources: [],
      limitations: ["No live conclusion is supported by invalid inputs."],
    };
  }
  const issue = researchInputIssue(tool, parsed.data);
  if (issue) {
    return {
      tool,
      status: "unavailable",
      summary: issue,
      observedAt: Date.now(),
      items: [],
      sources: [],
      limitations: ["Clarify the required input before requesting live data."],
    };
  }
  const [market, news] = await Promise.allSettled([
    toolReport(tool, parsed.data, signal),
    researchNews(tool, parsed.data, signal),
  ]);
  const newsData = news.status === "fulfilled" ? news.value : undefined;
  const result =
    market.status === "fulfilled"
      ? market.value
      : {
          tool,
          status: "unavailable" as const,
          summary: `${RESEARCH_TOOLS[tool].label} market data could not be validated. Explain what is missing rather than inventing results.`,
          observedAt: Date.now(),
          items: [],
          sources: [],
          limitations: ["The requested live market data is unavailable."],
        };
  const validated = researchReportSchema.safeParse({
    ...result,
    status: result.items.length ? result.status : result.status === "unavailable" ? "unavailable" : "partial",
    observedAt: Date.now(),
    ...(newsData ? { news: newsData } : {}),
  });
  return validated.success
    ? validated.data
    : {
        tool,
        status: "unavailable",
        summary: "The market response did not pass validation. No market conclusion is supported.",
        observedAt: Date.now(),
        items: [],
        sources: [],
        limitations: ["Validated market evidence is required before choosing an action."],
        ...(newsData ? { news: newsData } : {}),
      };
}
