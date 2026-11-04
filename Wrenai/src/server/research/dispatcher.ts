import "server-only";
import { z } from "zod";
import type { ChatToolDefinition } from "@/server/ai/verified-chat-stream";
import { SquintUnavailable } from "@/server/squint/contracts";
import {
  type ActiveAgentTool,
  activeAgentToolSchema,
  isActiveAgentTool,
  REMOVED_AGENT_MESSAGE,
} from "@/shared/agent-scope";
import {
  RESEARCH_TOOLS,
  type ResearchInput,
  type ResearchReport,
  researchInputSchema,
  researchReportSchema,
  researchToolSchema,
} from "@/shared/research";
import { researchInputIssue } from "@/shared/research-input";
import { paymentResearch } from "./accounts-launches";
import { DECISION_GUIDANCE } from "./decision-guidance";
import { perpMarkets } from "./hyperliquid";
import { drySwapQuote } from "./intents";
import { memeResearch } from "./memes";
import { researchNews } from "./news";
import { perpTechnicalAnalysis } from "./perp-technicals";

export const RESEARCH_DEFINITIONS: readonly ChatToolDefinition[] = activeAgentToolSchema.options.map(
  (tool) => ({
    type: "function",
    function: {
      name: `research_${tool}`,
      description: `${RESEARCH_TOOLS[tool].description} ${DECISION_GUIDANCE[tool]} Public data only. Account must be explicit; decimal amounts must identify their asset. No signing or execution.`,
      parameters: z.toJSONSchema(researchInputSchema, { unrepresentable: "any" }),
      strict: false,
    },
  }),
);

type PublicReport = Omit<ResearchReport, "items" | "sources" | "limitations"> & {
  readonly items: readonly ResearchReport["items"][number][];
  readonly sources: readonly ResearchReport["sources"][number][];
  readonly limitations: readonly string[];
};
async function toolReport(
  tool: ActiveAgentTool,
  input: ResearchInput,
  signal: AbortSignal,
): Promise<PublicReport> {
  const base = { tool, observedAt: Date.now(), status: "ok" as const, limitations: [] };
  switch (tool) {
    case "perps": {
      const data = await perpMarkets(input.symbols, signal);
      const analyses = await Promise.allSettled(
        data.markets.map((market) => perpTechnicalAnalysis(market, signal)),
      );
      const verified = analyses.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const missing = input.symbols.filter(
        (symbol) => !data.markets.some((market) => market.market.name.toUpperCase() === symbol.toUpperCase()),
      );
      const failed = data.markets
        .filter((_market, index) => analyses[index]?.status !== "fulfilled")
        .map((market) => market.market.name);
      return {
        ...base,
        status: !missing.length && !failed.length && verified.length ? "ok" : "partial",
        summary:
          "Analyze the closed-candle trend together with live funding and available book liquidity. Give long/short/wait with reasons and invalidation; funding alone does not establish direction.",
        items: [...verified.map((analysis) => analysis.item), ...data.items],
        sources: [data.source, ...verified.flatMap((analysis) => analysis.sources)],
        technicals: verified.map((analysis) => analysis.technical),
        assessment:
          verified.length === 1 && verified[0]
            ? verified[0].assessment
            : verified.length > 1
              ? {
                  decision: "compare",
                  summary: verified
                    .map((analysis) => analysis.assessment.summary)
                    .join(" ")
                    .slice(0, 400),
                  reasons: verified.slice(0, 4).map((analysis) => analysis.assessment.summary),
                  conditions: [
                    "Assess each market separately using its 15m, 1h and 4h frames and recent news. Do not apply one market's signal to another.",
                  ],
                  sourceIds: [data.source.id],
                }
              : {
                  decision: "wait",
                  summary:
                    "Price history could not be validated; no directional technical signal is established.",
                  reasons: ["A current mark/funding snapshot alone is insufficient to choose long or short."],
                  conditions: ["Obtain fresh consecutive closed candles before choosing a side."],
                  sourceIds: [data.source.id],
                },
        limitations: [
          "Chart-derived setups require a fresh size-specific execution quote and user loss limits; these are not orders.",
          ...(missing.length ? [`Requested markets unavailable: ${missing.join(", ")}.`] : []),
          ...(failed.length
            ? [
                `Closed-bar evidence unavailable for: ${failed.join(", ")}; no technical signal is supported for those markets.`,
              ]
            : []),
        ],
      };
    }

    case "meme_hunter":
      return { ...base, status: "partial", ...(await memeResearch(input, signal)) };
    case "private_payments":
      return { ...base, status: "partial", ...(await paymentResearch(input, signal)) };
    case "dca":
    case "spot_trader":
    case "buy_the_dip":
    case "sell_the_top": {
      const data = await drySwapQuote(input, signal);
      const limits =
        tool === "spot_trader"
          ? "A fresh spot quote is information, not an order. Exact action, owned inventory, allocated budget, exits and limits need separate review."
          : tool === "dca"
            ? "A live pair quote does not create a schedule; schedule, timezone, budget and missed-run behavior need review."
            : tool === "buy_the_dip"
              ? "A quote alone does not establish a dip. The reference price/window and threshold must be supplied and validated."
              : "A quote alone does not establish profit. Confirmed entry cost, attributed inventory and net-profit targets are required.";
      return {
        ...base,
        status: "partial",
        summary: "Current size-specific spot quote for the requested pair. No trade was placed.",
        items: [data.item],
        sources: data.sources,
        limitations: [limits],
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
  const unavailable = (summary: string): ResearchReport => ({
    tool,
    status: "unavailable",
    summary,
    observedAt: Date.now(),
    items: [],
    sources: [],
    limitations: ["No validated live conclusion is supported."],
  });
  if (!isActiveAgentTool(tool)) {
    return unavailable(REMOVED_AGENT_MESSAGE);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawArguments);
  } catch {
    return unavailable("Specify valid public assets, account and amount units.");
  }
  const parsed = researchInputSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable("Specify valid public assets, account and amount units.");
  }
  const issue = researchInputIssue(tool, parsed.data);
  if (issue) {
    return unavailable(issue);
  }
  const [market, news] = await Promise.allSettled([
    toolReport(tool, parsed.data, signal),
    researchNews(tool, parsed.data, signal),
  ]);
  signal.throwIfAborted();
  const newsData = news.status === "fulfilled" ? news.value : undefined;
  const result =
    market.status === "fulfilled"
      ? market.value
      : market.reason instanceof SquintUnavailable && ["ambiguous", "not_found"].includes(market.reason.code)
        ? {
            ...unavailable(market.reason.message),
            assessment: {
              decision: "needs_input" as const,
              summary: market.reason.message,
              reasons: [],
              conditions: [],
              sourceIds: [],
            },
          }
        : unavailable(`${RESEARCH_TOOLS[tool].label} data is unavailable. Try again shortly.`);
  const validated = researchReportSchema.safeParse({
    ...result,
    status: result.items.length ? result.status : "unavailable",
    observedAt: Date.now(),
    ...(newsData ? { news: newsData } : {}),
  });
  return validated.success
    ? validated.data
    : unavailable("The market data did not pass validation. No conclusion is supported.");
}
