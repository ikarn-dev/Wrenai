import "server-only";
import { eq } from "drizzle-orm";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import { readUserRiskPolicy } from "@/server/guard/user-policy";
import { allocationCeiling, committedCapital } from "@/server/positions/capital-records";
import { type AgentPolicy, parseUsd, policySchema } from "@/shared/agents";
import type { UserRiskPolicyRecord } from "@/shared/risk-policy";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError, type ExecutionPlan } from "./contracts";
import { type ExecutionAction, executionHash, type LedgerAction } from "./records";
import { checkStrategyAssets } from "./strategy-assets";
import { readSpendingUsage, readSubmissionUsage } from "./usage";

interface ExecutionPolicy {
  readonly policy: AgentPolicy;
  readonly riskPolicy: UserRiskPolicyRecord;
  readonly publicKey: string;
  readonly policyHash: string;
}

export async function currentExecutionPolicy(
  db: AppDatabase,
  userId: string,
  plan: ExecutionPlan,
  signingPublicKey?: string,
): Promise<ExecutionPolicy> {
  const agent = await ownedAgent(db, userId, plan.agentId);
  // Both currently supported packs are confidential-only; a plan cannot select a public fallback.
  if (plan.scope !== "confidential") {
    throw new ExecutionError(
      "not_ready",
      "The current strategy packs require confidential Intents execution.",
    );
  }
  if (agent.status !== "running" || (await killSwitchEngaged(db, userId))) {
    throw new ExecutionError("not_ready", "The agent must be running and the global stop must be off.");
  }
  if (agent.revision !== plan.agentRevision || agent.version !== plan.strategyVersion) {
    throw new ExecutionError("conflict", "The strategy or policy revision changed. Create a new plan.");
  }
  const riskPolicy = await readUserRiskPolicy(db, userId);
  if (riskPolicy === null) {
    throw new ExecutionError("not_ready", "Set your account-wide trading limits before activation.");
  }
  if (plan.riskPolicyRevision !== riskPolicy.revision) {
    throw new ExecutionError("conflict", "Account-wide limits changed. Review a new plan.");
  }
  await checkStrategyAssets(db, plan);
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (
    key === undefined ||
    key.activatedAt === null ||
    key.activatedAtBlock === null ||
    (signingPublicKey !== undefined && key.publicKey !== signingPublicKey)
  ) {
    throw new ExecutionError("not_ready", "The bound Intents authorization is no longer active.");
  }
  const policy = policySchema.parse(JSON.parse(agent.policyJson));
  if (
    BigInt(plan.notionalMicroUsd) > parseUsd(policy.maxTradeUsd) ||
    plan.slippageBps > policy.maxSlippageBps ||
    (plan.providerFeeBps ?? 0) > policy.maxProviderFeeBps
  ) {
    throw new ExecutionError("limit", "The plan exceeds the current trade or slippage limit.");
  }
  return {
    policy,
    riskPolicy,
    publicKey: key.publicKey,
    policyHash: executionHash({
      agentPolicy: policy,
      userPolicyRevision: riskPolicy.revision,
      userPolicy: riskPolicy.policy,
    }),
  };
}

/** Reservation ceilings, not portfolio allocation/PnL. The Executor must also obtain a full Guard verdict. */
export async function checkReservationLimits(
  db: AppDatabase,
  userId: string,
  plan: ExecutionPlan,
  current: ExecutionPolicy,
  now: number,
  excludeActionId?: string,
): Promise<void> {
  const { policy, riskPolicy } = current;
  const usage = await readSpendingUsage(db, userId, plan.agentId, now, excludeActionId);
  const proposed = BigInt(plan.notionalMicroUsd);
  const reserved = usage.agentPendingMicroUsd + proposed;
  const allocation = await allocationCeiling(db, userId, plan.agentId);
  const ceiling = minimumUnits(allocation, parseUsd(policy.budgetUsd));
  if (
    reserved > ceiling ||
    (await committedCapital(db, userId, plan.agentId)) > ceiling ||
    reserved + usage.agentSpent24hMicroUsd > parseUsd(policy.dailyCapUsd) ||
    usage.userPendingMicroUsd + usage.userSpent24hMicroUsd + proposed >
      parseUsd(riskPolicy.policy.dailyCapUsd)
  ) {
    throw new ExecutionError(
      "limit",
      "Pending reservations exceed an agent budget or an account-wide/agent daily spending ceiling.",
    );
  }
}

export async function checkSubmissionRate(
  db: AppDatabase,
  action: LedgerAction,
  policy: AgentPolicy,
  now: number,
): Promise<void> {
  const usage = await readSubmissionUsage(db, action.userId, action.agentId, now);
  if (
    usage.submissionsLastHour >= BigInt(policy.maxTradesPerHour) ||
    (usage.lastSubmissionAt !== null &&
      usage.lastSubmissionAt + BigInt(policy.cooldownSeconds * 1000) > BigInt(now))
  ) {
    throw new ExecutionError("limit", "The agent's trade frequency or cooldown limit is reached.");
  }
}

export async function recheckExecution(
  db: AppDatabase,
  action: ExecutionAction,
  plan: ExecutionPlan,
  now: number,
): Promise<ExecutionPolicy> {
  const current = await currentExecutionPolicy(db, action.userId, plan, action.signingPublicKey);
  if (current.policyHash !== action.policyHash || now >= action.expiresAt || action.approvedAt === null) {
    throw new ExecutionError("not_ready", "The plan expired, changed, or still needs its bound approval.");
  }
  return current;
}
