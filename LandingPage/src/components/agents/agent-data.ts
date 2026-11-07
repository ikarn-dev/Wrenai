// The seven active agents, from the app's own definitions: Wrenai/src/shared/agent-scope.ts (the list),
// agent-templates.ts (every number in the scenes comes from these example setups) and engine/check.ts (check
// cadence: 5 s for market-driven agents, 60 s for scheduled ones, shown in the scenes' lifecycles). Nothing here
// goes beyond what the app does.

export type AgentPack =
  | "private_payments"
  | "dca"
  | "spot_trader"
  | "perps"
  | "meme_hunter"
  | "buy_the_dip"
  | "sell_the_top";

export interface AgentSlide {
  /** The app's agent type, used for the create link, its icon and its scene. */
  readonly pack: AgentPack;
  readonly name: string;
  readonly text: string;
}

export const AGENTS: readonly AgentSlide[] = [
  {
    pack: "private_payments",
    name: "Private Payments",
    text: "Sends an exact payment from your private balance, to a confidential account or a labeled public NEAR wallet.",
  },
  {
    pack: "dca",
    name: "DCA",
    text: "Buys a fixed amount on your schedule, for as many purchases as you set.",
  },
  {
    pack: "spot_trader",
    name: "Spot Trader",
    text: "Buys or sells at market or at your price, with optional take-profit, stop-loss and trailing exits.",
  },
  {
    pack: "perps",
    name: "Perps",
    text: "Opens isolated-margin longs and shorts on Hyperliquid. Every new position needs a stop-loss.",
  },
  {
    pack: "meme_hunter",
    name: "Meme Hunter",
    text: "Finds new NEAR listings with Squint and buys only those that pass every token, liquidity and route check.",
  },
  {
    pack: "buy_the_dip",
    name: "Buy the Dip",
    text: "Buys when the price holds below your level, or a set drop below a recent high.",
  },
  {
    pack: "sell_the_top",
    name: "Sell the Top",
    text: "Sells what you hold at your net-profit targets, with an optional trailing stop.",
  },
];
