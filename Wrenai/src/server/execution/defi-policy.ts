import "server-only";
import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims, defiPositions } from "@/server/db/defi-schema";
import { readUserRiskPolicy } from "@/server/guard/user-policy";
import { allocationCeiling, committedCapital } from "@/server/positions/capital-records";
import { type AgentPolicy, parseUsd, policySchema } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError } from "./contracts";
import type { DefiPlan } from "./defi-contracts";
import { requireExecutionPermission } from "./permissions";
import { executionHash, type LedgerAction } from "./records";
import { readSpendingUsage } from "./usage";

export async function checkDefiPositions(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
  actionId?: string,
): Promise<void> {
  for (const p of plan.positions) {
    const [marketPosition] = await db
      .select()
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, userId),
          eq(defiPositions.scope, plan.scope),
          eq(defiPositions.venueId, plan.venueId),
          p.kind === "perp_long" || p.kind === "perp_short"
            ? or(
                eq(defiPositions.kind, p.kind),
                and(
                  inArray(defiPositions.kind, ["perp_long", "perp_short"]),
                  gt(defiPositions.quantityUnits, 0n),
                ),
              )
            : eq(defiPositions.kind, p.kind),
          eq(defiPositions.instrumentId, p.instrumentId),
        ),
      )
      .limit(1);
    if (marketPosition && marketPosition.id !== p.positionId) {
      throw new ExecutionError("conflict", "Use the existing position identity for this market.");
    }
    const [row] = await db.select().from(defiPositions).where(eq(defiPositions.id, p.positionId)).limit(1);
    if (
      (row === undefined && (p.expectedVersion !== 0 || p.beforeUnits !== "0")) ||
      (row !== undefined &&
        (row.userId !== userId ||
          row.agentId !== plan.agentId ||
          row.scope !== plan.scope ||
          row.kind !== p.kind ||
          row.instrumentId !== p.instrumentId ||
          row.venueId !== plan.venueId ||
          row.version !== p.expectedVersion ||
          row.quantityUnits !== BigInt(p.beforeUnits)))
    ) {
      throw new ExecutionError(
        "conflict",
        "The position changed or belongs to another agent. Refresh before execution.",
      );
    }
    const [claim] = await db
      .select()
      .from(defiPositionClaims)
      .where(
        and(
          eq(defiPositionClaims.userId, userId),
          eq(defiPositionClaims.scope, plan.scope),
          eq(defiPositionClaims.venueId, plan.venueId),
          p.kind === "perp_long" || p.kind === "perp_short"
            ? inArray(defiPositionClaims.kind, ["perp_long", "perp_short"])
            : eq(defiPositionClaims.kind, p.kind),
          eq(defiPositionClaims.instrumentId, p.instrumentId),
          isNull(defiPositionClaims.releasedAt),
          actionId === undefined ? undefined : ne(defiPositionClaims.actionId, actionId),
        ),
      )
      .limit(1);
    if (claim !== undefined) {
      throw new ExecutionError("conflict", "Another unresolved action holds this position.");
    }
  }
}

export async function currentDefiPolicy(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
  now: number,
  action?: LedgerAction,
): Promise<{ policy: AgentPolicy; policyHash: string; publicKey: string }> {
  const agent = await ownedAgent(db, userId, plan.agentId);
  if (agent.status !== "running" || (await killSwitchEngaged(db, userId))) {
    throw new ExecutionError("not_ready", "The agent must be running and the global stop must be off.");
  }
  if (agent.revision !== plan.agentRevision || agent.version !== plan.strategyVersion) {
    throw new ExecutionError("conflict", "The agent revision changed.");
  }
  const risk = await readUserRiskPolicy(db, userId);
  if (risk === null || risk.revision !== plan.riskPolicyRevision) {
    throw new ExecutionError("not_ready", "Review the current account-wide trading limits.");
  }
  const permission = await requireExecutionPermission(db, userId, plan, now);
  const policy = policySchema.parse(JSON.parse(agent.policyJson));
  const policyHash = executionHash({
    agentPolicy: policy,
    userPolicyRevision: risk.revision,
    userPolicy: risk.policy,
    permissionHash: plan.permissionHash,
  });
  if (
    action &&
    (action.signingPublicKey !== permission.signingPublicKey ||
      action.policyHash !== policyHash ||
      action.approvedAt === null)
  ) {
    throw new ExecutionError("not_ready", "The action's key, policy or approval changed.");
  }
  if (plan.expiresAt <= now || plan.expiresAt > now + 300_000) {
    throw new ExecutionError("not_ready", "The execution quote is expired or too far in the future.");
  }
  const usage = await readSpendingUsage(db, userId, agent.id, now, action?.id);
  const proposed = BigInt(plan.notionalMicroUsd);
  const ceiling = minimumUnits(await allocationCeiling(db, userId, agent.id), parseUsd(policy.budgetUsd));
  if (
    proposed > parseUsd(policy.maxTradeUsd) ||
    plan.slippageBps > policy.maxSlippageBps ||
    plan.providerFeeBps > policy.maxProviderFeeBps ||
    usage.agentPendingMicroUsd + proposed > ceiling ||
    (await committedCapital(db, userId, agent.id, action?.id)) +
      (plan.operation === "borrow" ? proposed : 0n) >
      ceiling ||
    usage.agentPendingMicroUsd + usage.agentSpent24hMicroUsd + proposed > parseUsd(policy.dailyCapUsd) ||
    usage.userPendingMicroUsd + usage.userSpent24hMicroUsd + proposed > parseUsd(risk.policy.dailyCapUsd)
  ) {
    throw new ExecutionError(
      "limit",
      "The action exceeds its fee, slippage, capital or shared spending limit.",
    );
  }
  await checkDefiPositions(db, userId, plan, action?.id);
  return { policy, policyHash, publicKey: permission.signingPublicKey };
}
