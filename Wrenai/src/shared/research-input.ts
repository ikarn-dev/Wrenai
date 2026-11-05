import type { ResearchInput, ResearchTool } from "./research";

/** Essential public inputs, checked before any market/news request; omitted amounts may use labeled samples. */
export function researchInputIssue(tool: ResearchTool, input: ResearchInput): string | null {
  if (input.amount !== undefined) {
    if (!/[1-9]/.test(input.amount)) {
      return "Use an amount greater than zero.";
    }
    if (!input.amountAsset) {
      return "Specify which asset the amount is measured in.";
    }
  }
  if (["triggers", "dca", "spot_trader", "buy_the_dip", "sell_the_top"].includes(tool)) {
    if (input.symbols.length !== 2) {
      return "Specify both assets for the swap, such as wNEAR to USDC.";
    }
    if (input.symbols[0]?.toUpperCase() === input.symbols[1]?.toUpperCase()) {
      return "Choose two different assets for the swap.";
    }
    if (tool !== "triggers" && !input.amount) {
      return "Specify how much of the pay token to quote.";
    }
    if (
      input.amountAsset &&
      !input.symbols.some((symbol) => symbol.toUpperCase() === input.amountAsset?.toUpperCase())
    ) {
      return "Specify the amount in an asset from the requested pair.";
    }
  }
  if (tool === "perps" && !input.symbols.length) {
    return "Which perpetual market should I analyze, such as NEAR, BTC or ETH?";
  }
  if (tool === "copy_trading" && !input.accountId) {
    return "Provide the public account of the trader you want to research.";
  }
  if (tool === "private_payments") {
    if (!input.accountId) {
      return "Provide the recipient’s public NEAR account.";
    }
    if (/^0x/i.test(input.accountId)) {
      return "Private Payments requires a NEAR recipient account.";
    }
  }
  return null;
}
