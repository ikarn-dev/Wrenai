import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "./agent-scope";
import { isPaymentRetry, parseChatPayment } from "./chat-payment-command";
import { RESEARCH_TOOLS, type ResearchTool } from "./research";

// Deliberately explicit cues only. Ambiguous follow-ups stay with the selected tool and history.
const TOPICS: readonly { readonly tool: ResearchTool; readonly pattern: RegExp }[] = [
  {
    tool: "spot_trader",
    pattern: /\b(?:spot trad(?:e|er|ing)|spot buy|spot sell|buy and sell|manual spot)\b/i,
  },
  {
    tool: "dca",
    pattern: /\b(?:dca|dollar[- ]cost|recurring (?:purchases?|buys?)|buy (?:every|weekly|daily))\b/i,
  },
  { tool: "buy_the_dip", pattern: /\b(?:buy (?:the )?dips?|dip buying|buy below|drawdown entry)\b/i },
  {
    tool: "sell_the_top",
    pattern:
      /\b(?:sell (?:the )?top|profit targets?|take[- ]profit|profit threshold|sell when|exit ladder)\b/i,
  },
  {
    tool: "whale_tracker",
    pattern: /\b(?:whales?|smart money|wallet movements?|on[- ]chain movements?|large transfers?)\b/i,
  },
  {
    tool: "arbitrage",
    pattern: /\b(?:arbitrage|arb|price gaps?|price discrepancies|round[- ]trip spreads?)\b/i,
  },
  {
    tool: "copy_trading",
    pattern:
      /\b(?:copy[- ]trad(?:e|ing)|leader(?:board|s)?|mirror(?:ing)? trades?|follow (?:this|a) trader)\b/i,
  },
  {
    tool: "rebalancer",
    pattern: /\b(?:rebalanc\w*|portfolio allocations?|allocation drift|target weights?)\b/i,
  },
  {
    tool: "triggers",
    pattern: /\b(?:price trigger agent|generic trigger agent)\b/i,
  },
  {
    tool: "meme_hunter",
    pattern: /\b(?:meme ?coins?|meme ?tokens?|meme[. ]cooking|meme hunter|token launches?)\b/i,
  },
  {
    tool: "private_payments",
    pattern:
      /\b(?:private payments?|payments?|recipients?|send (?:funds|money|\d)|transfer (?:funds|money|\d))\b/i,
  },
  {
    tool: "perps",
    pattern:
      /\b(?:perps?|perpetuals?|hyperliquid|funding rates?|long or short|long\/short|(?:go|should i|do i) (?:long|short))\b/i,
  },
  {
    tool: "lp_manager",
    pattern:
      /\b(?:liquidity pools?|liquidity provid\w*|lp(?:s| manager)?|impermanent loss|concentrated liquidity)\b/i,
  },
  {
    tool: "lending_margin",
    pattern: /\b(?:lend\w*|borrow\w*|collateral|repay\w*|liquidation|lending \/ margin)\b/i,
  },
  {
    tool: "yield_optimizer",
    pattern: /\b(?:yields?|yield optimizer|stak\w*|unstak\w*|apy|aprs?|earn opportunities)\b/i,
  },
];

function clauseTools(clause: string): readonly ResearchTool[] {
  const tools = TOPICS.filter(({ pattern }) => pattern.test(clause)).map(({ tool }) => tool);
  if (tools.includes("perps")) {
    return tools.filter((tool) => tool !== "sell_the_top");
  }
  if (tools.includes("spot_trader")) {
    return tools.filter((tool) => tool !== "sell_the_top");
  }
  // These umbrella requests naturally mention their underlying instruments.
  if (tools.includes("arbitrage")) {
    return ["arbitrage"];
  }
  if (
    tools.includes("yield_optimizer") &&
    (/\byields? (?:opportunities|options|optimizer)\b|\b(?:best|optimi[sz]\w*) (?:near )?yields?\b/i.test(
      clause,
    ) ||
      (tools.includes("lending_margin") && /\bstak\w*\b/i.test(clause)))
  ) {
    return tools.filter((tool) => !["lending_margin", "lp_manager"].includes(tool));
  }
  if (tools.some((tool) => tool === "lending_margin" || tool === "lp_manager" || tool === "meme_hunter")) {
    return tools.filter((tool) => tool !== "yield_optimizer");
  }
  return tools;
}

export function requestedResearchTools(message: string): readonly ResearchTool[] {
  if (parseChatPayment(message) || isPaymentRetry(message)) {
    return ["private_payments"];
  }
  const text = message
    .normalize("NFKC")
    .replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, " ")
    .replace(
      /\b(?:not|don't|do not|without|avoid|ignore)\s+(?:staking|yields?|perps?|arbitrage|lending|borrowing|dca|rebalancing|payments?|memecoins?)\b/gi,
      " ",
    );
  const clauses = text.split(
    /[;\n]+|\b(?:and|also|then|plus)\s+(?=(?:find|compare|show|analy[sz]e|research|check|scan|rebalance|borrow|send)\b)/i,
  );
  return [...new Set(clauses.flatMap(clauseTools))];
}

/** Cheap preflight shared by the composer and server. Never silently change an explicit selection. */
export function chatRoutingIssue(message: string, selected: ResearchTool | null): string | null {
  if (selected && !isActiveAgentTool(selected)) {
    return REMOVED_AGENT_MESSAGE;
  }
  const requested = requestedResearchTools(message);
  if (
    requested.some((tool) => !isActiveAgentTool(tool)) &&
    (selected !== null ||
      /\b(?:live|current|opportunities|find|scan|create|agent|trade|track|watch|monitor)\b/i.test(message))
  ) {
    return REMOVED_AGENT_MESSAGE;
  }
  if (!selected) {
    return null;
  }
  if (!requested.length) {
    return /\b(?:poem|recipe|translate|debug|weather|capital of|write (?:an? )?(?:email|story|letter|song|python|javascript))\b/i.test(
      message,
    )
      ? "This looks unrelated to the selected research tool. Choose Auto to continue."
      : null;
  }
  if (requested.length === 1 && requested[0] === selected) {
    return null;
  }
  if (requested.length > 1) {
    return "This request spans multiple tools. Choose Auto, or ask about only the selected tool.";
  }
  const target = requested[0];
  return target
    ? `This request fits ${RESEARCH_TOOLS[target].label}, but ${RESEARCH_TOOLS[selected].label} is selected. Switch to ${RESEARCH_TOOLS[target].label} or Auto and send again.`
    : null;
}

export function needsLiveResearch(message: string, selected: ResearchTool | null = null): boolean {
  return (
    (selected !== null || requestedResearchTools(message).length > 0) &&
    /\b(?:live|current|today|now|latest|opportunities|recommend|should i|find|scan)\b/i.test(message)
  );
}
