import type { ManualIntent } from "./manual-trading";

export function manualAgentBrief(intent: ManualIntent): string {
  if (intent.kind === "spot") {
    return `Automate spot swaps spending ${intent.amount} of ${intent.inputAssetId} to buy ${intent.outputAssetId}. Maximum slippage ${intent.slippageBps} bps and provider fee ${intent.maximumFeeBps} bps. Ask me for the entry condition and protective exits before saving.`;
  }
  if (intent.kind === "perps") {
    return `Create a ${intent.market} Perps agent to ${intent.action} ${intent.quantity} ${intent.market} ${intent.side}, isolated ${intent.leverage}x leverage, maximum margin ${intent.maximumMarginUsd} USDC. Stop-loss ${intent.stopLossPrice ?? "needs review"}; take-profit ${intent.takeProfitPrice ?? "not set"}; trailing stop ${intent.trailingStopBps === null ? "off" : `${intent.trailingStopBps} bps`}. Maximum slippage ${intent.slippageBps} bps. Review the entry condition and expiry with me.`;
  }
  return "Review the trading strategy, exact token budget and conditions for a new Perps agent.";
}
