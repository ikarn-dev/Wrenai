import type { ResearchTool } from "./research";

/** These are reviewed setup types. None authorizes live execution. */
export const AGENT_CATALOG = {
  rebalancer: {
    name: "Rebalancing Agent",
    description: "Plan target allocations and when to rebalance your assets.",
    prompt: "Compare allocation options for my assets and explain which balance fits my goals.",
    fields: ["Assets and target weights", "Drift that should trigger a rebalance", "Review frequency"],
  },
  triggers: {
    name: "Price Trigger Agent",
    description: "Plan price-based entries, exits and recurring purchases.",
    prompt: "Help me choose entry and exit conditions using current prices and market context.",
    fields: ["Asset and quote token", "Entry condition and order size", "Take-profit, stop-loss and expiry"],
  },
  copy_trading: {
    name: "Copy Trading Agent",
    description: "Evaluate a public wallet before choosing activity to follow.",
    prompt: "Help me evaluate a public trading account, including evidence gaps and follower costs.",
    fields: ["Public leader account", "Trades or assets to follow", "Maximum copied size and exit rules"],
  },
  yield_optimizer: {
    name: "Yield Agent",
    description: "Compare lending, staking and yield options with withdrawal costs.",
    prompt: "Compare current yield options for my assets and recommend a suitable approach with reasons.",
    fields: ["Assets and amount", "Withdrawal timing", "Risk limits and allowed protocols"],
  },
  meme_hunter: {
    name: "Meme Hunter Agent",
    description: "Research token launches, liquidity and reasons to avoid a market.",
    prompt:
      "Research NEAR meme markets and explain which candidates deserve a closer look or should be avoided.",
    fields: [
      "Tokens or launch criteria",
      "Minimum liquidity and maximum exposure",
      "Entry, exit and loss limits",
    ],
  },
  private_payments: {
    name: "Private Payments Agent",
    description: "Prepare recipient, asset and payment requirements for review.",
    prompt: "Help me review a payment recipient and the requirements for a private payment route.",
    fields: ["Recipient account", "Asset, amount and timing", "Required privacy and approval rules"],
  },
  lp_manager: {
    name: "Liquidity Agent",
    description: "Compare liquidity pools, fee income assumptions and position risks.",
    prompt:
      "Compare suitable NEAR liquidity pools and explain which approach fits my assets and risk limits.",
    fields: ["Assets and pool", "Deposit amount and position range", "Rebalance and withdrawal conditions"],
  },
  lending_margin: {
    name: "Lending Agent",
    description: "Compare supply and borrowing costs while planning collateral limits.",
    prompt: "Compare current lending markets and explain whether supplying or borrowing fits my goal.",
    fields: [
      "Supply or borrow assets",
      "Collateral and maximum borrow amount",
      "Health buffer and repayment conditions",
    ],
  },
  perps: {
    name: "Perpetuals Agent",
    description: "Assess long, short or wait using trend, funding, liquidity and news.",
    prompt:
      "Analyze NEAR perpetuals using price history, funding, liquidity and recent news. Recommend long, short or wait, with reasons and invalidation conditions.",
    fields: [
      "Market and time horizon",
      "Long, short or conditional entry",
      "Position size, leverage, stop-loss and take-profit",
    ],
  },
  arbitrage: {
    name: "Arbitrage Agent",
    description: "Compare actual routes and identify gaps that survive verified costs.",
    prompt:
      "Find current arbitrage candidates and recommend whether to pursue or wait after checking fees, liquidity and execution constraints.",
    fields: ["Assets and venues", "Sample size and minimum net edge", "Leg risk, slippage and exit limits"],
  },
} as const satisfies Record<
  ResearchTool,
  {
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly fields: readonly string[];
  }
>;
