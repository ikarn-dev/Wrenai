import { type AgentPolicy, DEFAULT_POLICY } from "@/shared/agents";
import type { ManualIntent } from "@/shared/manual-trading";

/** Only supplies exact order rounding/fee controls to the shared compiler; it grants no ongoing authority. */
export function manualOrderPolicy(intent: ManualIntent): AgentPolicy {
  return {
    ...DEFAULT_POLICY,
    budgetUsd: "999999999",
    maxTradeUsd: "999999999",
    dailyCapUsd: "999999999",
    approvalMode: "every_action",
    maxSlippageBps: intent.slippageBps,
    maxProviderFeeBps: intent.maximumFeeBps,
    cooldownSeconds: 0,
    allowRiskReducingExits: true,
  };
}
