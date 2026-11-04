import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import type { DefiPlan } from "@/server/execution/defi-contracts";
import { ownedWalletFunding, walletFundingView } from "./records";

/** Called again under the Signer lock. A model flag never authorizes a wallet funding exception. */
export async function verifiedWalletFunding(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
  actionId?: string,
): Promise<boolean> {
  if (!plan.walletFundingId) {
    return false;
  }
  const row = await ownedWalletFunding(db, userId, plan.walletFundingId),
    snapshot = walletFundingView(row).snapshot;
  const source = plan.cash.find((cash) => (cash.scope ?? plan.scope) === "intents"),
    destination = plan.cash.find((cash) => cash.scope === "confidential");
  if (
    !row.transactionHash ||
    !row.confirmedAt ||
    !row.walletAttemptAt ||
    !["deposited", "converting"].includes(row.state) ||
    row.agentId !== plan.agentId ||
    row.strategyVersion !== plan.strategyVersion ||
    (actionId !== undefined && row.actionId !== actionId) ||
    !plan.funding ||
    plan.returnFunds ||
    plan.budgetMode !== "per_agent" ||
    plan.scope !== "intents" ||
    plan.venueId !== "near-intents" ||
    plan.operation !== "transfer" ||
    plan.recipient !== snapshot.accountId ||
    plan.positions.length !== 0 ||
    plan.cash.length !== 2 ||
    source?.assetId !== snapshot.assetId ||
    source.maxDebitUnits !== snapshot.units ||
    source.minCreditUnits !== "0" ||
    destination?.assetId !== snapshot.assetId ||
    destination.maxDebitUnits !== "0" ||
    BigInt(destination.minCreditUnits) < BigInt(snapshot.minimumPrivateUnits) ||
    plan.slippageBps > snapshot.maximumSlippageBps ||
    plan.providerFeeBps > snapshot.maximumProviderFeeBps
  ) {
    throw new ExecutionError(
      "not_ready",
      "The funding transfer differs from its confirmed wallet deposit and fee limits.",
    );
  }
  return true;
}
