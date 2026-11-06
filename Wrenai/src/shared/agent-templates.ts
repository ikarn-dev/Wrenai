import { type ActiveAgentTool, isActiveAgentTool } from "./agent-scope";

export interface AgentStrategyTemplate {
  readonly name: string;
  readonly hint: string;
  readonly text: string;
}

interface AgentSetupProfile {
  readonly instructions: string;
  readonly guidance: string;
  readonly templates: readonly AgentStrategyTemplate[];
  readonly budget: string;
  readonly limits: string;
  readonly action: string;
  readonly actions: string;
  readonly protectiveExits: boolean;
}

export const PERPS_TEMPLATE_ENTRY = {
  market: "ETH",
  quantity: "0.006",
  leverage: 2,
  maximumMarginUsd: "15",
  suggestedOrderCapUsd: "25",
} as const;
const ETH_SIZE = `${PERPS_TEMPLATE_ENTRY.quantity} ${PERPS_TEMPLATE_ENTRY.market}`;
const ETH_MARGIN = `isolated ${PERPS_TEMPLATE_ENTRY.leverage}x leverage, funded with {{funding token}}, and a $${PERPS_TEMPLATE_ENTRY.maximumMarginUsd} margin cap including fees`;
const PERPS_LIMIT_HINT = `Allow up to $${PERPS_TEMPLATE_ENTRY.suggestedOrderCapUsd} per order for this example. Check the live quote.`;

const SETUPS = {
  private_payments: {
    instructions: "Payment instructions",
    guidance:
      "Specify the recipient, token, amount, and send time. Choose a confidential balance or a public NEAR wallet.",
    templates: [
      {
        name: "Send privately now",
        hint: "One exact payment to a confidential balance.",
        text: "Send {{amount}} {{token}} privately to {{recipient account}} once. Send as soon as the agent starts. Expire one hour after review.",
      },
      {
        name: "Schedule a public payout",
        hint: "The recipient and payment appear on-chain.",
        text: "Send {{amount}} {{token}} once to the public wallet {{recipient account}} at 09:00 UTC tomorrow. Expire at 11:00 UTC tomorrow.",
      },
    ],
    budget: "Payment allocation",
    limits: "Payment limits",
    action: "payment",
    actions: "payments",
    protectiveExits: false,
  },
  dca: {
    instructions: "Purchase schedule",
    guidance: "Specify the token pair, amount per purchase, schedule and time zone, and maximum purchases.",
    templates: [
      {
        name: "Buy NEAR daily",
        hint: "One USDC purchase per day on public RHEA.",
        text: "Spend {{amount}} USDC to buy native NEAR daily at 09:00 UTC. Make up to seven buys. Skip missed buys and stop in eight days.",
      },
      {
        name: "Four purchases every 12 hours",
        hint: "A fixed interval starting one hour after review.",
        text: "Spend {{amount}} {{pay token}} to buy {{buy token}} every 12 hours, starting one hour after review. Make up to four buys. Skip missed buys and expire in three days.",
      },
    ],
    budget: "Purchase budget",
    limits: "Purchase limits",
    action: "purchase",
    actions: "purchases",
    protectiveExits: false,
  },
  spot_trader: {
    instructions: "Spot order instructions",
    guidance:
      "Specify buy or sell, the exact pair, size, and entry. For buys, include any take-profit or stop-loss prices.",
    templates: [
      {
        name: "Market buy with price exits",
        hint: "Use a take-profit above and a stop-loss below the expected entry.",
        text: "Spend {{amount}} {{pay token}} to buy {{buy token}} once at market. Measure prices in the pay token. Take profit at {{take profit price}} and stop at {{stop loss price}}. Expire in seven days.",
      },
      {
        name: "Sell at a price threshold",
        hint: "Sell from this agent’s allocation.",
        text: "Sell {{amount}} {{sell token}} for {{receive token}} once the price reaches or exceeds {{sale price}} in the receive token. Stop in seven days.",
      },
      {
        name: "Buy native NEAR once",
        hint: "Spend USDC on public RHEA.",
        text: "Spend {{amount}} USDC to buy native NEAR once at market. Stop after the purchase or in 24 hours.",
      },
    ],
    budget: "Spot trading budget",
    limits: "Spot order limits",
    action: "order",
    actions: "orders",
    protectiveExits: true,
  },
  perps: {
    instructions: "Position instructions",
    guidance:
      "Specify the market, action, side, quantity, collateral token, and leverage. Opening a position requires a stop.",
    templates: [
      {
        name: "ETH long with price exits",
        hint: PERPS_LIMIT_HINT,
        text: `Open a market long for ${ETH_SIZE} with ${ETH_MARGIN}. Take profit at USD {{take profit price}} and stop at USD {{stop loss price}}. Expire in 24 hours and keep exit orders open.`,
      },
      {
        name: "ETH short with a trailing stop",
        hint: PERPS_LIMIT_HINT,
        text: `Short ${ETH_SIZE} when the ETH mark is at or below USD {{entry price}}. Use ${ETH_MARGIN}. Set a stop at USD {{stop loss price}} with a 2% trailing stop. Expire in 24 hours and keep exit orders open.`,
      },
    ],
    budget: "Collateral budget",
    limits: "Perps order limits",
    action: "order",
    actions: "orders",
    protectiveExits: true,
  },
  meme_hunter: {
    instructions: "Discovery and entry rules",
    guidance:
      "Specify the pay token, buy size, listing age, liquidity, holder concentration, quote loss, and maximum positions.",
    templates: [
      {
        name: "Fresh listings with one position",
        hint: "Nearly launches under 12 hours old with a 12% trailing stop.",
        text: "Spend {{amount}} {{pay token}} per buy on eligible Nearly launches under 12 hours old. Require $3,000 liquidity, a 10% holder or linked-group cap, and 2% maximum impact and round-trip quote loss. Hold one position. Use a 12% trailing stop in USD. Stop new buys after three days.",
      },
      {
        name: "Two-position discovery",
        hint: "Nearly launches under 48 hours old with a 15% trailing stop.",
        text: "Spend {{amount}} {{pay token}} per buy on eligible Nearly launches under 48 hours old. Require $5,000 liquidity, an 8% holder or linked-group cap, and 2% maximum impact and round-trip quote loss. Hold up to two positions. Use a 15% trailing stop in USD. Stop new buys after seven days.",
      },
    ],
    budget: "Memecoin budget",
    limits: "Memecoin order limits",
    action: "order",
    actions: "orders",
    protectiveExits: true,
  },
  buy_the_dip: {
    instructions: "Dip and buy rules",
    guidance:
      "Specify the pair, size, and a target price or drawdown from a rolling high. Include the entry count and cooldown.",
    templates: [
      {
        name: "Buy below a fixed price",
        hint: "One purchase after a 30-second price confirmation.",
        text: "Spend {{amount}} {{pay token}} to buy {{buy token}} once. Buy when the price stays at or below {{dip price}} in the pay token for 30 seconds. Use a five-minute cooldown. Expire in seven days.",
      },
      {
        name: "Buy an 8% rolling drawdown",
        hint: "Uses an observed four-hour high and up to three entries.",
        text: "Spend {{amount}} {{pay token}} per buy on {{buy token}}. Buy when the price in the pay token stays 8% below its four-hour high for 30 seconds. Make up to three buys, two hours apart at minimum. Expire in seven days.",
      },
    ],
    budget: "Dip purchase budget",
    limits: "Dip order limits",
    action: "order",
    actions: "orders",
    protectiveExits: true,
  },
  sell_the_top: {
    instructions: "Profit-taking rules",
    guidance:
      "Specify the owned token and quantity, the receive token, confirmed cost basis, and how much to sell at each net-profit target.",
    templates: [
      {
        name: "Single net-profit target",
        hint: "Sell the allocated position at one 20% target.",
        text: "Track {{owned amount}} {{sell token}}. My total cost was {{total cost}} in {{receive token}}. Sell that quantity at 20% net profit in the receive token. Expire in seven days.",
      },
      {
        name: "Scale out with a trailing stop",
        hint: "Sell in two stages, with a trailing stop while a target is pending.",
        text: "Track {{owned amount}} {{sell token}}. My total cost was {{total cost}} in {{receive token}}. Sell 25% at 15% net profit and 75% at 30%, measured in the receive token. Use an 8% trailing stop while a target is pending. Expire in seven days.",
      },
    ],
    budget: "Sale allocation",
    limits: "Sale limits",
    action: "sale",
    actions: "sales",
    protectiveExits: true,
  },
} satisfies Readonly<Record<ActiveAgentTool, AgentSetupProfile>>;

const LEGACY_SETUP: AgentSetupProfile = {
  instructions: "Strategy instructions",
  guidance: "Specify the assets, amounts, and conditions.",
  templates: [],
  budget: "Token budget",
  limits: "Trading limits",
  action: "trade",
  actions: "trades",
  protectiveExits: true,
};

export function agentSetupProfile(pack: string): AgentSetupProfile {
  return isActiveAgentTool(pack) ? SETUPS[pack] : LEGACY_SETUP;
}
