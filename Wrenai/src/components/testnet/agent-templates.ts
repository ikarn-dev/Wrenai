import type { AgentStrategyTemplate } from "@/shared/agent-templates";
import type { testnetAgentToolSchema } from "@/shared/testnet-agents";

type Tool = (typeof testnetAgentToolSchema.options)[number];

/** Starting points for each testnet agent type, written in the shape the testnet parser expects. */
export const TEMPLATES: Readonly<Record<Tool, readonly AgentStrategyTemplate[]>> = {
  private_payments: [
    {
      name: "One payment",
      hint: "Choose a NEAR wallet budget and fill in the recipient.",
      text: "Send 0.005 NEAR once from my wallet to {{recipient}}.",
    },
    {
      name: "Public Intents payment",
      hint: "Choose a USDC public Intents budget and fill in the recipient.",
      text: "Send 0.5 USDC once from my public Intents balance to {{recipient}} in their public Intents balance.",
    },
  ],
  spot_trader: [
    {
      name: "Buy ETH",
      hint: "One swap using USDC.",
      text: "Spend 0.5 USDC once to buy ETH. Receive in my public Intents balance.",
    },
    {
      name: "Swap stablecoins",
      hint: "One swap using USDT.",
      text: "Spend 0.5 USDT once to buy USDC. Receive in my wallet.",
    },
  ],
  dca: [
    {
      name: "ETH every minute",
      hint: "Uses the selected USDC budget.",
      text: "Spend 0.5 USDC to buy ETH every 60 seconds for one hour. Receive in my public Intents balance.",
    },
    {
      name: "BTC every five minutes",
      hint: "Uses the selected USDT budget.",
      text: "Spend 0.5 USDT to buy wBTC every 300 seconds for one hour. Receive in my public Intents balance.",
    },
  ],
  buy_the_dip: [
    {
      name: "ETH dip",
      hint: "One buy after a 5% drop from activation.",
      text: "Spend 0.5 USDC to buy ETH once after its price drops 5% from activation. Receive in my public Intents balance.",
    },
    {
      name: "BTC dip",
      hint: "One buy after a 3% drop from activation.",
      text: "Spend 0.5 USDT to buy wBTC once after its price drops 3% from activation. Receive in my public Intents balance.",
    },
  ],
  sell_the_top: [
    {
      name: "Take 5% profit",
      hint: "Fill in the actual acquisition cost.",
      text: "Sell 0.0001 ETH for USDC once when proceeds are 5% above its acquisition cost of {{cost}} USDC. Receive in my public Intents balance.",
    },
    {
      name: "Take 10% profit",
      hint: "Fill in the actual acquisition cost.",
      text: "Sell 0.000001 wBTC for USDT once when proceeds are 10% above its acquisition cost of {{cost}} USDT. Receive in my public Intents balance.",
    },
  ],
};
