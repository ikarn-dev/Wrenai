import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditAgent, ownedAgent } from "@/server/agents/records";
import { fulfilSetupBudget } from "@/server/agents/setup-binding";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { intentsStatusSchema, readIntentsProviderStatus } from "@/server/execution/intents-reconciliation";
import { verifiedProviderQuote } from "@/server/execution/oneclick-quote";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash } from "@/server/execution/records";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { parseUsd, policySchema } from "@/shared/agents";
import { directNativeFunding } from "@/shared/wallet-funding";
import { fundingRequestPart } from "./deposit";
import { nativeDepositRequest } from "./prepare";
import { ownedWalletFunding, walletFundingView } from "./records";

/**
 * One bounded check of a native NEAR deposit sent straight to the private balance. Returns true while 1Click is
 * still delivering. The agent is credited only with the amount 1Click reports delivered; a refund goes back to the
 * wallet and leaves the budget unfunded, so it can be funded again.
 */
export async function settleDirectFunding(
  db: AppDatabase,
  owner: string,
  fundingId: string,
): Promise<boolean> {
  const row = await ownedWalletFunding(db, owner, fundingId),
    snapshot = walletFundingView(row).snapshot;
  if (row.state !== "deposited" || !directNativeFunding(snapshot) || row.transactionHash === null) {
    return false;
  }
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(snapshot.depositAddress));
  // The provider's echoed quote must be the exact reviewed request, signed by 1Click.
  const echoed = z.object({ timestamp: z.iso.datetime() }).parse(status.quoteResponse);
  verifiedProviderQuote(
    status.quoteResponse,
    nativeDepositRequest(
      snapshot.accountId,
      snapshot.units,
      snapshot.maximumSlippageBps,
      snapshot.requestDeadline,
    ),
    "intents",
    Date.parse(echoed.timestamp),
    snapshot.maximumSlippageBps,
  );
  z.object({ quote: z.object({ depositAddress: z.literal(snapshot.depositAddress) }) }).parse(
    status.quoteResponse,
  );
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    return true;
  }
  const details = status.swapDetails;
  const delivered = BigInt(details.amountOut ?? "0");
  if (
    details.amountIn === undefined ||
    details.refundedAmount === undefined ||
    details.depositedAmount !== snapshot.units ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(snapshot.units) ||
    (status.status === "SUCCESS" &&
      (delivered < BigInt(snapshot.minimumPrivateUnits) || delivered > BigInt(snapshot.units))) ||
    (status.status === "REFUNDED" && delivered !== 0n)
  ) {
    throw new ExecutionError(
      "not_ready",
      "1Click hasn't fully accounted for this deposit yet. It's checked again.",
    );
  }
  if (delivered > 0n) {
    await synchronizePrivateInventory(db, owner);
  }
  await userTransaction(db, owner, async (tx) => {
    const current = await ownedWalletFunding(tx, owner, fundingId),
      now = await databaseTime(tx);
    if (current.state !== "deposited" || current.transactionHash !== row.transactionHash) {
      return;
    }
    if (delivered > 0n) {
      const agent = await ownedAgent(tx, owner, current.agentId),
        policy = policySchema.parse(JSON.parse(agent.policyJson));
      await setAgentCapitalLimit(tx, owner, {
        requestId: fundingRequestPart(current.id, "limit"),
        agentId: current.agentId,
        amountMicroUsd: parseUsd(policy.budgetUsd).toString(),
      });
      await assignInventory(tx, owner, {
        requestId: fundingRequestPart(current.id, "direct"),
        agentId: current.agentId,
        scope: "confidential",
        assetId: snapshot.assetId,
        quantityUnits: delivered.toString(),
        capitalMicroUsd: snapshot.principalMicroUsd,
        costBasisMicroUsd: null,
        sourceReference: `oneclick:${snapshot.depositAddress}`,
        evidenceHash: executionHash({ snapshot, transactionHash: current.transactionHash, details }),
      });
      await fulfilSetupBudget(tx, owner, current.agentId, snapshot.assetId, snapshot.units);
    }
    await tx
      .update(walletFundings)
      .set({ state: "complete", updatedAt: now })
      .where(eq(walletFundings.id, current.id));
    await auditAgent(
      tx,
      owner,
      current.agentId,
      delivered > 0n ? "wallet_funding_delivered" : "wallet_funding_refunded",
      delivered > 0n
        ? "Funds arrived in the agent's private balance."
        : "1Click refunded the deposit to your wallet. Add funds again to deploy.",
      { fundingId: current.id, deliveredUnits: delivered.toString() },
    );
  });
  return false;
}
