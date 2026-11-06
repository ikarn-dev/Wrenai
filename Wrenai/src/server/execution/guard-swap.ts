import "server-only";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { evaluateGuard } from "@/server/guard/evaluate";
import type { GuardVerdict } from "@/server/guard/types";
import { allocationCeiling, committedCapital } from "@/server/positions/capital-records";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { parseUsd, policySchema } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError, type ExecutionPlan } from "./contracts";
import { planRiskPolicy } from "./plan-risk";
import { verifiedReducingExit } from "./reducing-exit";
import { allowsPublicAgentSwap, checkStrategyAssets } from "./strategy-assets";
import { readSpendingUsage, readSubmissionUsage } from "./usage";

/** Authoritative final Guard, called inside the Signer's owner transaction before producing any signature. */
export async function requireSwapGuard(
  db: AppDatabase,
  userId: string,
  plan: ExecutionPlan,
  now: number,
  actionId?: string,
  approvalGranted = false,
): Promise<void> {
  const verdict = await swapGuardVerdict(db, userId, plan, now, actionId, approvalGranted);
  if (verdict.status !== "approved") {
    throw new ExecutionError("not_ready", verdict.reason);
  }
}

export async function swapGuardVerdict(
  db: AppDatabase,
  userId: string,
  plan: ExecutionPlan,
  now: number,
  actionId?: string,
  approvalGranted = false,
): Promise<GuardVerdict> {
  const agent = await ownedAgent(db, userId, plan.agentId);
  if (plan.scope !== "confidential" && !allowsPublicAgentSwap(agent.pack, plan)) {
    throw new ExecutionError("not_ready", "The current swap packs cannot select public execution.");
  }
  await checkStrategyAssets(db, plan);
  const policy = policySchema.parse(JSON.parse(agent.policyJson));
  const riskReducingExit = await verifiedReducingExit(db, userId, plan, policy, actionId);
  const risk = await planRiskPolicy(db, userId, plan);
  const usage = await readSpendingUsage(db, userId, agent.id, now, actionId);
  const submissions = await readSubmissionUsage(db, userId, agent.id, now);
  const nativeAccount = plan.scope === "native_near" ? await activeTradingAccount(db, userId) : null;
  if (plan.scope === "native_near" && !nativeAccount?.backupConfirmedAt) {
    throw new ExecutionError(
      "not_ready",
      "Confirm the native trading account recovery backup before trading.",
    );
  }
  return evaluateGuard(
    {
      id: plan.requestId,
      agentId: agent.id,
      tier: plan.scope === "native_near" ? "public" : "private",
      kind: "swap",
      purpose: riskReducingExit ? "exit" : agent.pack === "rebalancer" ? "rebalance" : "entry",
      sellAssetId: plan.inputAssetId,
      buyAssetId: plan.outputAssetId,
      destination: nativeAccount
        ? { type: "chain", chain: "near", address: nativeAccount.nativeAccountId }
        : { type: "confidential" },
      amountMicroUsd: BigInt(plan.notionalMicroUsd),
      slippageBps: plan.slippageBps,
      providerFeeBps: plan.providerFeeBps ?? 0,
      edge: null,
    },
    {
      now,
      killSwitchEngaged: await killSwitchEngaged(db, userId),
      agentStatus: agent.status === "error" ? "stopped" : agent.status,
      requiresPositiveEdge: false,
      newCapitalMicroUsd: 0n,
      riskReducingExit,
      allowedAssetIds: new Set([plan.inputAssetId, plan.outputAssetId]),
      allowedChains: new Set(nativeAccount ? ["near"] : []),
      limits: {
        maxTradeMicroUsd: parseUsd(policy.maxTradeUsd),
        userDailyCapMicroUsd: risk ? parseUsd(risk.policy.dailyCapUsd) : null,
        agentDailyCapMicroUsd: parseUsd(policy.dailyCapUsd),
        maxSlippageBps: policy.maxSlippageBps,
        maxProviderFeeBps: policy.maxProviderFeeBps,
        maxTradesPerHour: policy.maxTradesPerHour,
        approvalThresholdMicroUsd: parseUsd(policy.approvalThresholdUsd),
      },
      usage: {
        userSpent24hMicroUsd: usage.userSpent24hMicroUsd + usage.userPendingMicroUsd,
        agentSpent24hMicroUsd: usage.agentSpent24hMicroUsd + usage.agentPendingMicroUsd,
        agentCommittedMicroUsd: await committedCapital(db, userId, agent.id),
        agentBudgetMicroUsd: minimumUnits(
          await allocationCeiling(db, userId, agent.id),
          parseUsd(policy.budgetUsd),
        ),
        agentTradesLastHour: Number(submissions.submissionsLastHour),
        agentLastTradeAt: submissions.lastSubmissionAt === null ? null : Number(submissions.lastSubmissionAt),
        agentCooldownMs: policy.cooldownSeconds * 1000,
      },
      approval: { mode: policy.approvalMode, granted: approvalGranted },
    },
  );
}
