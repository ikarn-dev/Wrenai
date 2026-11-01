import { agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { ledgerStrategyFixture } from "@/server/execution/test-context";
import { DEFAULT_POLICY } from "@/shared/agents";
import { assignInventory } from "./attribution";
import { setAgentCapitalLimit } from "./capital-limits";

export const TEST_ASSET = "nep141:usdc.test-fixture.near";
export async function addTestAgent(db: AppDatabase, userId = "owner"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(agents).values({
    id,
    userId,
    name: `Offline ${id}`,
    pack: "rebalancer",
    status: "running",
    reason: "Offline fixture",
    policyJson: JSON.stringify({ ...DEFAULT_POLICY, approvalMode: "autonomous", cooldownSeconds: 0 }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.insert(strategyVersions).values(ledgerStrategyFixture(id));
  return id;
}

export async function assignTestInventory(
  db: AppDatabase,
  agentId: string,
  quantityUnits = "1000",
  capitalMicroUsd = "1000000",
  costBasisMicroUsd: string | null = capitalMicroUsd,
): Promise<string> {
  return assignInventory(db, "owner", {
    requestId: crypto.randomUUID(),
    agentId,
    scope: "confidential",
    assetId: TEST_ASSET,
    quantityUnits,
    capitalMicroUsd,
    costBasisMicroUsd,
    sourceReference: "offline-source",
    evidenceHash: "c".repeat(64),
  });
}

export async function observeTestAssets(
  db: AppDatabase,
  balances: readonly { readonly assetId: string; readonly amountUnits: string }[],
): Promise<void> {
  const syncToken = await beginInventorySync(db, "owner", "confidential");
  await finishInventorySync(db, "owner", { scope: "confidential", syncToken, balances });
}

export async function allocateTestAgent(
  db: AppDatabase,
  agentId: string,
  amountMicroUsd = "100000000",
): Promise<void> {
  await setAgentCapitalLimit(db, "owner", { requestId: crypto.randomUUID(), agentId, amountMicroUsd });
}
