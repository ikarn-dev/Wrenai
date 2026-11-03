import "server-only";
import { and, eq } from "drizzle-orm";
import { strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { ExecutionError } from "./contracts";
import type { DefiPlan } from "./defi-contracts";
import { perpsCashAssetId } from "./hyperliquid/contracts";

/** Funding moves already allocated principal; the exception is never authorized by a model-supplied flag alone. */
export async function verifiedAccountFunding(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
): Promise<boolean> {
  if (!plan.funding) {
    return false;
  }
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.agentId, plan.agentId), eq(strategyVersions.version, plan.strategyVersion)),
    )
    .limit(1);
  const instruction = agentInstructionSchema.parse(version ? JSON.parse(version.configJson) : null);
  const account = await readAgentTradingAccount(db, userId, plan.agentId),
    root = await activeTradingAccount(db, userId);
  const debit = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    credit = plan.cash.find((cash) => cash.scope === "hyperliquid");
  if (
    instruction.kind !== "perps" ||
    !account ||
    !root ||
    account.rootId !== root.id ||
    root.backupVersion !== 2 ||
    root.backupConfirmedAt === null ||
    plan.budgetMode !== "per_agent" ||
    plan.scope !== "confidential" ||
    plan.operation !== "transfer" ||
    plan.venueId !== "confidential-intents" ||
    plan.positions.length !== 0 ||
    plan.cash.length !== 2 ||
    debit?.assetId !== instruction.collateralAssetId ||
    (debit.scope !== undefined && debit.scope !== "confidential") ||
    debit.minCreditUnits !== "0" ||
    credit?.assetId !== perpsCashAssetId(account.perpAddress) ||
    credit.maxDebitUnits !== "0" ||
    BigInt(credit.minCreditUnits) <= 0n ||
    plan.recipient !== account.perpAddress
  ) {
    throw new ExecutionError(
      "not_ready",
      "Funding must move this agent's allocated token to its own backed-up Perps address.",
    );
  }
  return true;
}
