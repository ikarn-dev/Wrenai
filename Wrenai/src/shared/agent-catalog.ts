import type { ResearchTool } from "./research";

/** Eight active setup types plus display-only historical metadata. None authorizes live execution. */
export const AGENT_CATALOG = {
  spot_trader: {
    name: "Spot Trader Agent",
    description: "Plan spot buys, sells and profit-taking with your allocated tokens and limits.",
    prompt:
      "Review a spot buy or sell with the exact token pair, size, current quote, costs and any take-profit, stop-loss or trailing rules. Chat does not submit the trade.",
    fields: [
      "Buy or sell, exact tokens and chain",
      "Size, amount unit and order conditions",
      "Take-profit, stop-loss, trailing rules and expiry",
    ],
  },
  dca: {
    name: "DCA Agent",
    description: "Plan recurring spot purchases with a fixed budget and schedule.",
    prompt:
      "Review a DCA purchase pair, schedule, costs and spending limits. Ask for essential missing details.",
    fields: [
      "Buy asset, pay asset and amount per purchase",
      "Schedule, timezone, start and end",
      "Total budget, slippage and missed-run rule",
    ],
  },
  whale_tracker: {
    name: "Whale / Smart Money Tracker",
    description: "Watch confirmed public wallet movements and evidence-backed trading patterns.",
    prompt:
      "Research confirmed public movements for a watched account. Distinguish transfers from trades and show what can actually be established.",
    fields: [
      "Watched public accounts, chain and tokens",
      "Transfer threshold with asset or USD unit",
      "Alert conditions and duplicate/cooldown rules",
    ],
  },
  buy_the_dip: {
    name: "Buy the Dip Agent",
    description: "Plan spot buys when a defined price or drawdown condition is reached.",
    prompt:
      "Review a spot buy-the-dip setup with an explicit reference price or rolling-high window, threshold, sizing and risk limits.",
    fields: [
      "Buy/pay assets, chain and dip reference",
      "Price or percentage threshold and reference window",
      "Order size, total budget, cooldown and expiry",
    ],
  },
  sell_the_top: {
    name: "Sell the Top Agent",
    description: "Plan spot exits at your profit targets, with optional trailing protection.",
    prompt:
      "Review profit-target spot exits using confirmed cost basis, all known fees, sell percentages and optional trailing stop. Do not claim to identify the actual top.",
    fields: [
      "Owned asset, chain and confirmed cost basis",
      "Net-profit targets and percentage to sell at each",
      "Trailing rule, minimum output and expiry",
    ],
  },
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
    description: "Copy confirmed public NEAR-origin 1Click swaps within your reviewed assets and limits.",
    prompt: "Help me evaluate a public trading account, including evidence gaps and follower costs.",
    fields: [
      "Public NEAR leader and assets to follow",
      "Fixed copy size in USD",
      "Signal-age limit, price deviation and expiry",
    ],
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
    description: "Analyze directional setups and plan trades with take-profit, stop-loss and trailing rules.",
    prompt:
      "Analyze the specified perpetual market and horizon with chart indicators, funding, liquidity and recent news. Give the supported long/short bias, strength, entry, TP, SL and invalidation; separate analysis from trade eligibility.",
    fields: [
      "Market and time horizon",
      "Long, short or conditional entry",
      "Position size, leverage, take-profit, stop-loss and trailing rule",
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
