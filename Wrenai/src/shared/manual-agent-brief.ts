import type { ManualIntent } from "./manual-trading";

export function manualAgentBrief(intent: ManualIntent): string {
  if (intent.kind === "spot") {
    return `Automate spot swaps spending ${intent.amount} of ${intent.inputAssetId} to buy ${intent.outputAssetId}. Maximum slippage ${intent.slippageBps} bps and provider fee ${intent.maximumFeeBps} bps. Ask me for the entry condition and protective exits before saving.`;
  }
  if (intent.kind === "perps") {
    return `${intent.action} a ${intent.market} ${intent.side} for ${intent.quantity} ${intent.market} with isolated ${intent.leverage}x leverage. Use my selected funding token and a $${intent.maximumMarginUsd} margin limit. Stop loss ${intent.stopLossPrice ?? "needs review"}. Take profit ${intent.takeProfitPrice ?? "off"}. Trailing stop ${intent.trailingStopBps === null ? "off" : `${intent.trailingStopBps / 100}%`}. Maximum slippage ${intent.slippageBps / 100}%. Review the entry and expiry with me.`;
  }
  return "Review the trading strategy, exact token budget and conditions for a new Perps agent.";
}
