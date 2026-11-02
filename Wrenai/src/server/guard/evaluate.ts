import { z } from "zod";
import { formatMicroUsd } from "@/shared/money";
import {
  type GuardBlock,
  type GuardContext,
  type GuardRule,
  type GuardVerdict,
  type Proposal,
  proposalSchema,
} from "./types";

type Check = (proposal: Proposal, context: GuardContext) => GuardBlock | null;

function block(rule: GuardRule, reason: string): GuardBlock {
  return { status: "blocked", rule, reason };
}

const checkKillSwitch: Check = (_proposal, context) =>
  context.killSwitchEngaged ? block("kill_switch", "Blocked: the kill switch is on") : null;

const checkAgentStatus: Check = (_proposal, context) =>
  context.agentStatus === "running"
    ? null
    : block("agent_status", `Blocked: the agent is ${context.agentStatus}`);

const checkAllowlist: Check = (proposal, context) => {
  for (const assetId of [proposal.sellAssetId, proposal.buyAssetId]) {
    if (!context.allowedAssetIds.has(assetId)) {
      return block("allowlist", `Blocked: ${assetId} is not on your token allowlist`);
    }
  }
  const { destination } = proposal;
  if (destination.type === "chain" && !context.allowedChains.has(destination.chain)) {
    return block("allowlist", `Blocked: ${destination.chain} is not on your chain allowlist`);
  }
  return null;
};

// A Private-tier pack can never move funds out of the confidential balance (Spec §5 rule 3).
const checkTier: Check = (proposal) => {
  if (proposal.tier !== "private") {
    return null;
  }
  if (proposal.kind === "unshield") {
    return block("tier", "Blocked: a Private-tier agent can't unshield funds");
  }
  if (proposal.destination.type !== "confidential") {
    return block("tier", "Blocked: a Private-tier agent can only send funds to your confidential balance");
  }
  return null;
};

const checkMaxTrade: Check = (proposal, context) =>
  !context.riskReducingExit && proposal.amountMicroUsd > context.limits.maxTradeMicroUsd
    ? block(
        "max_trade",
        `Blocked: ${formatMicroUsd(proposal.amountMicroUsd)} is over your ${formatMicroUsd(context.limits.maxTradeMicroUsd)} per-trade limit`,
      )
    : null;

const checkDailyCap: Check = (proposal, context) => {
  if (context.riskReducingExit) {
    return null;
  }
  const { limits, usage } = context;
  const userTotal = usage.userSpent24hMicroUsd + proposal.amountMicroUsd;
  if (limits.userDailyCapMicroUsd !== null && userTotal > limits.userDailyCapMicroUsd) {
    return block(
      "daily_cap",
      `Blocked: this trade would bring your 24-hour total to ${formatMicroUsd(userTotal)}, over your ${formatMicroUsd(limits.userDailyCapMicroUsd)} cap`,
    );
  }
  const agentTotal = usage.agentSpent24hMicroUsd + proposal.amountMicroUsd;
  if (agentTotal > limits.agentDailyCapMicroUsd) {
    return block(
      "daily_cap",
      `Blocked: this trade would bring the agent's 24-hour total to ${formatMicroUsd(agentTotal)}, over its ${formatMicroUsd(limits.agentDailyCapMicroUsd)} cap`,
    );
  }
  return null;
};

const checkBudget: Check = (_proposal, context) => {
  if (context.newCapitalMicroUsd < 0n) {
    return block("budget", "Blocked: the capital requirement is invalid");
  }
  const committed = context.usage.agentCommittedMicroUsd + context.newCapitalMicroUsd;
  return committed > context.usage.agentBudgetMicroUsd
    ? block(
        "budget",
        `Blocked: this trade would commit ${formatMicroUsd(committed)} of the agent's ${formatMicroUsd(context.usage.agentBudgetMicroUsd)} budget`,
      )
    : null;
};

const checkCooldown: Check = (_proposal, context) => {
  if (context.riskReducingExit) {
    return null;
  }
  const { agentLastTradeAt, agentCooldownMs } = context.usage;
  if (agentLastTradeAt === null || agentCooldownMs === 0) {
    return null;
  }
  const remainingMs = agentLastTradeAt + agentCooldownMs - context.now;
  return remainingMs > 0
    ? block("cooldown", `Blocked: the agent's cooldown has ${Math.ceil(remainingMs / 1000)} s left`)
    : null;
};

const checkSlippage: Check = (proposal, context) =>
  proposal.slippageBps > context.limits.maxSlippageBps
    ? block(
        "slippage",
        `Blocked: ${proposal.slippageBps} bps slippage is over your ${context.limits.maxSlippageBps} bps limit`,
      )
    : null;

const checkProviderFee: Check = (proposal, context) =>
  (proposal.providerFeeBps ?? 0) > (context.limits.maxProviderFeeBps ?? 0)
    ? block(
        "provider_fee",
        `Blocked: the provider fee of ${proposal.providerFeeBps} bps exceeds your ${context.limits.maxProviderFeeBps ?? 0} bps cap`,
      )
    : null;

const checkEdge: Check = (proposal, context) => {
  if (proposal.edge === null) {
    return context.requiresPositiveEdge
      ? block("edge_gate", "Blocked: this strategy requires an estimated net edge")
      : null;
  }
  const { expectedGainMicroUsd, costMicroUsd } = proposal.edge;
  return expectedGainMicroUsd > costMicroUsd
    ? null
    : block(
        "edge_gate",
        `Blocked: expected gain ${formatMicroUsd(expectedGainMicroUsd)} doesn't beat fees and slippage of ${formatMicroUsd(costMicroUsd)}`,
      );
};

const checkRateLimit: Check = (_proposal, context) =>
  !context.riskReducingExit && context.usage.agentTradesLastHour >= context.limits.maxTradesPerHour
    ? block(
        "rate_limit",
        `Blocked: the agent already made ${context.usage.agentTradesLastHour} trades in the last hour, its limit is ${context.limits.maxTradesPerHour}`,
      )
    : null;

// Order matters: the first failing check blocks (Spec §5).
const CHECKS: readonly Check[] = [
  checkKillSwitch,
  checkAgentStatus,
  checkAllowlist,
  checkTier,
  checkMaxTrade,
  checkDailyCap,
  checkBudget,
  checkCooldown,
  checkSlippage,
  checkProviderFee,
  checkEdge,
  checkRateLimit,
];

function approvalReason(proposal: Proposal, context: GuardContext): string | null {
  if (context.approval.granted) {
    return null;
  }
  switch (context.approval.mode) {
    case "autonomous":
      return null;
    case "every_action":
      return "Needs your approval: this agent asks before every action";
    case "above_size":
      return proposal.amountMicroUsd > context.limits.approvalThresholdMicroUsd
        ? `Needs your approval: ${formatMicroUsd(proposal.amountMicroUsd)} is over your ${formatMicroUsd(context.limits.approvalThresholdMicroUsd)} approval threshold`
        : null;
    default: {
      const unhandled: never = context.approval.mode;
      throw new Error(`Unhandled approval mode: ${String(unhandled)}`);
    }
  }
}

/**
 * Deterministic policy check for one proposal. Pure: the same input always gives the same verdict.
 * The proposal is parsed first, so malformed or free-text input is blocked, never executed.
 */
export function evaluateGuard(rawProposal: unknown, context: GuardContext): GuardVerdict {
  const parsed = proposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    return block("schema", `Blocked: the proposal is malformed. ${z.prettifyError(parsed.error)}`);
  }
  const proposal = parsed.data;
  for (const check of CHECKS) {
    const failure = check(proposal, context);
    if (failure !== null) {
      return failure;
    }
  }
  const reason = approvalReason(proposal, context);
  return reason === null ? { status: "approved", proposal } : { status: "needs_approval", proposal, reason };
}
