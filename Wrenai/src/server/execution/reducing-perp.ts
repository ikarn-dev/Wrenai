import "server-only";
import { and, eq } from "drizzle-orm";
import { strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { agentTradingAccounts } from "@/server/db/trading-account-schema";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import type { AgentPolicy } from "@/shared/agents";
import { ExecutionError } from "./contracts";
import type { DefiPlan } from "./defi-contracts";
import { perpsCashAssetId, perpsInstrumentId } from "./hyperliquid/contracts";

/** Position ownership/version/claims are also checked by checkDefiPositions under the same owner lock. */
export async function verifiedReducingPerpExit(
  db: AppDatabase,
  plan: DefiPlan,
  policy: AgentPolicy,
): Promise<boolean> {
  if (!plan.reduceOnly) {
    return false;
  }
  if (
    !policy.allowRiskReducingExits ||
    plan.budgetMode !== "per_agent" ||
    plan.operation !== "perp_reduce" ||
    plan.scope !== "hyperliquid" ||
    plan.venueId !== "hyperliquid"
  ) {
    throw new ExecutionError(
      "not_ready",
      "This policy does not authorize a position-reducing venue exit outside entry caps.",
    );
  }
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.agentId, plan.agentId), eq(strategyVersions.version, plan.strategyVersion)),
    )
    .limit(1);
  const parsed = agentInstructionSchema.safeParse(version ? JSON.parse(version.configJson) : null);
  const instruction = parsed.success ? parsed.data : null;
  const [account] = await db
    .select()
    .from(agentTradingAccounts)
    .where(eq(agentTradingAccounts.agentId, plan.agentId))
    .limit(1);
  const exposures = plan.positions.filter((p) => p.kind === "perp_long" || p.kind === "perp_short");
  const exposure = exposures[0];
  // Hyperliquid settles fees and collateral in six-decimal USDC account units.
  const maximumFee = (BigInt(plan.notionalMicroUsd) * BigInt(policy.maxProviderFeeBps) + 9999n) / 10_000n;
  if (
    instruction?.kind !== "perps" ||
    exposures.length !== 1 ||
    !exposure ||
    exposure.instrumentId !==
      (account ? perpsInstrumentId(account.perpAddress, instruction.market) : instruction.market) ||
    exposure.kind !== (instruction.side === "long" ? "perp_long" : "perp_short") ||
    BigInt(exposure.beforeUnits) <= 0n ||
    BigInt(exposure.maxAfterUnits) >= BigInt(exposure.beforeUnits) ||
    plan.positions.some((p) => BigInt(p.maxAfterUnits) > BigInt(p.beforeUnits)) ||
    plan.cash.length !== 1 ||
    plan.cash.some(
      (cash) =>
        cash.assetId !== (account ? perpsCashAssetId(account.perpAddress) : instruction.collateralAssetId) ||
        BigInt(cash.maxDebitUnits) > maximumFee,
    )
  ) {
    throw new ExecutionError(
      "limit",
      "A protective perpetual exit must strictly reduce its owned market exposure and debit only bounded venue fees.",
    );
  }
  return true;
}
