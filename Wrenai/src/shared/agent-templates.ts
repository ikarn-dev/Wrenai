import { type ActiveAgentTool, isActiveAgentTool } from "./agent-scope";

/**
 * The strategy each agent type opens with in the create dialog: one complete, editable example written the way
 * the strategy parser reads it (exact tokens, amounts, timing and exits). The user edits the values before
 * Deploy; verification still reviews whatever text is sent. The payment recipient is left as a bracketed
 * placeholder, which is not a valid account, so a payment can never be saved without the user naming one.
 */
export const AGENT_TEMPLATES: Readonly<Record<ActiveAgentTool, string>> = {
  dca: "Buy NEAR with 5 USDC every day at 09:00 UTC for 30 days. Skip a purchase if slippage would be above 1%.",
  spot_trader:
    "Buy NEAR with 20 USDC now. Sell all of it if NEAR rises 15% above my entry price or falls 8% below it.",
  buy_the_dip:
    "Buy NEAR with 25 USDC when NEAR falls 10% below its 7-day high. Buy at most once per day, for up to 4 buys.",
  sell_the_top:
    "Sell 25% of my NEAR at each 20% net-profit step above my cost basis of $3.00, up to 75% in total. After the first sale, add a 5% trailing stop.",
  perps:
    "Open a 2x long on ETH with 20 USDC margin when the hourly close is above the 20-hour average. Take profit at +6% and stop loss at -3%.",
  meme_hunter:
    "Buy 2 NEAR of new NEAR memecoins under 48 hours old with at least $20,000 liquidity and a Clean risk grade. Sell all at +50% or -20%.",
  private_payments:
    "Send 10 USDC from my private balance to [recipient].near on the 1st of each month at 09:00 UTC.",
};

/** The preset strategy for a pack, or an empty string for a pack outside the active catalog. */
export function agentTemplate(pack: string): string {
  return isActiveAgentTool(pack) ? AGENT_TEMPLATES[pack] : "";
}
