import { perpsInstruction, perpsPolicy } from "@tests/server/execution/hyperliquid/fixtures";
import { executionTestContext, fundTestAgent, observeInventory } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { agentRuntimes, agents, strategyVersions } from "@/server/db/agent-schema";
import { delegatedKeys } from "@/server/db/schema";
import { tradingAccounts } from "@/server/db/trading-account-schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { initialPerpsState } from "@/server/engine/perps-state";
import { executionHash } from "@/server/execution/records";
import { ensureAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { ensureTradingAccount } from "@/server/trading-accounts/vault";

export async function perpsTestContext(): Promise<
  Awaited<ReturnType<typeof executionTestContext>> & {
    readonly instruction: ReturnType<typeof perpsInstruction>;
    readonly account: Awaited<ReturnType<typeof ensureAgentTradingAccount>>;
  }
> {
  const context = await executionTestContext(perpsPolicy, {}, false),
    instruction = perpsInstruction({
      exits: { stopLossPrice: "4", takeProfitPrice: "6", trailingStopBps: null },
    });
  await context.db.update(agents).set({ pack: "perps" }).where(eq(agents.id, context.agentId));
  await context.db
    .update(strategyVersions)
    .set({
      configJson: JSON.stringify(instruction),
      resolvedAssetsJson: JSON.stringify({
        strategyHash: executionHash(instruction),
        assets: [{ symbol: instruction.collateralAssetId, assetId: instruction.collateralAssetId }],
      }),
    })
    .where(eq(strategyVersions.agentId, context.agentId));
  await context.db.update(delegatedKeys).set(generateAgentKey()).where(eq(delegatedKeys.userId, "owner"));
  const root = await ensureTradingAccount(context.db, "owner");
  await context.db
    .update(tradingAccounts)
    .set({ backupVersion: 2, backupConfirmedAt: Date.now(), backupFileHash: "1".repeat(64) })
    .where(eq(tradingAccounts.id, root.id));
  const account = await ensureAgentTradingAccount(context.db, "owner", context.agentId);
  await observeInventory(context.db, "confidential", "20000000");
  await fundTestAgent(context.db, context.agentId, "20000000", "20000000");
  await context.db.insert(agentRuntimes).values({
    userId: "owner",
    agentId: context.agentId,
    activationId: crypto.randomUUID(),
    inputHash: "a".repeat(64),
    agentRevision: 1,
    strategyVersion: 1,
    state: "active",
    strategyStateJson: JSON.stringify(initialPerpsState),
    nextCheckAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { ...context, instruction, account };
}
