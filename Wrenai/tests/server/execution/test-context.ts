import { testDatabase } from "@tests/server/db/test-database";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import type { ExecutionPlan, ExecutionScope } from "@/server/execution/contracts";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { executionHash, ownedExecution } from "@/server/execution/records";
import { setUserRiskPolicy } from "@/server/guard/user-policy";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit, setUserCapitalLimit } from "@/server/positions/capital-limits";
import { type AgentPolicy, DEFAULT_POLICY, parseUsd, strategySchema } from "@/shared/agents";
import type { UserRiskPolicy } from "@/shared/risk-policy";

export function ledgerStrategyFixture(agentId: string): typeof strategyVersions.$inferInsert {
  const strategy = strategySchema.parse({
    kind: "rebalancer",
    targets: [
      { symbol: "NEAR", weightBps: 4000 },
      { symbol: "USDC", weightBps: 4000 },
      { symbol: "BTC", weightBps: 1000 },
      { symbol: "USDT", weightBps: 1000 },
    ],
    driftBps: 500,
    intervalSeconds: 300,
  });
  return {
    id: crypto.randomUUID(),
    agentId,
    version: 1,
    strategyText: "Offline strategy fixture.",
    configJson: JSON.stringify(strategy),
    attestationJson: "{}",
    createdAt: Date.now(),
    resolvedAssetsJson: JSON.stringify({
      strategyHash: executionHash(strategy),
      assets: [
        { symbol: "NEAR", assetId: "nep141:wrap.near" },
        { symbol: "USDC", assetId: "nep141:usdc.test-fixture.near" },
        { symbol: "BTC", assetId: "nep141:other-output.near" },
        { symbol: "USDT", assetId: "nep141:unrelated.near" },
      ],
    }),
  };
}

/** Offline fixtures only. These keys, balances and receipts are never wired into application routes. */
export async function executionTestContext(
  policy: Partial<AgentPolicy> = {},
  riskPolicy: Partial<UserRiskPolicy> = {},
  legacyAccountPolicy = true,
): Promise<Awaited<ReturnType<typeof testDatabase>> & { agentId: string }> {
  const context = await testDatabase();
  const agentId = crypto.randomUUID();
  await context.db.insert(agents).values({
    id: agentId,
    userId: "owner",
    name: "Ledger Test Agent",
    pack: "rebalancer",
    status: "running",
    reason: "Offline test fixture",
    policyJson: JSON.stringify({
      ...DEFAULT_POLICY,
      approvalMode: "autonomous",
      cooldownSeconds: 0,
      ...policy,
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await context.db.insert(strategyVersions).values(ledgerStrategyFixture(agentId));
  await context.db.insert(delegatedKeys).values({
    userId: "owner",
    publicKey: "ed25519:offline-test-key",
    sealedSecret: Buffer.alloc(60),
    createdAt: Date.now(),
    activatedAt: Date.now(),
    activatedAtBlock: 1,
  });
  await setUserCapitalLimit(context.db, "owner", {
    requestId: crypto.randomUUID(),
    amountMicroUsd: "1000000000",
  });
  await setAgentCapitalLimit(context.db, "owner", {
    requestId: crypto.randomUUID(),
    agentId,
    amountMicroUsd: parseUsd(policy.budgetUsd ?? DEFAULT_POLICY.budgetUsd).toString(),
  });
  if (legacyAccountPolicy) {
    await setUserRiskPolicy(context.db, "owner", {
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      policy: {
        dailyCapUsd: "1000",
        ...riskPolicy,
      },
    });
  }
  return { ...context, agentId };
}

export async function fundTestAgent(
  db: AppDatabase,
  agentId: string,
  quantityUnits = "10000",
  capitalMicroUsd = "10000000",
): Promise<string> {
  return assignInventory(db, "owner", {
    requestId: crypto.randomUUID(),
    agentId,
    scope: "confidential",
    assetId: "nep141:usdc.test-fixture.near",
    quantityUnits,
    capitalMicroUsd,
    costBasisMicroUsd: capitalMicroUsd,
    sourceReference: "offline-attribution",
    evidenceHash: "c".repeat(64),
  });
}

export function executionPlan(agentId: string, overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    requestId: crypto.randomUUID(),
    agentId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 1,
    scope: "confidential",
    inputAssetId: "nep141:usdc.test-fixture.near",
    outputAssetId: "nep141:wrap.near",
    inputUnits: "1000",
    minOutputUnits: "100",
    notionalMicroUsd: "10000000",
    slippageBps: 50,
    quoteId: crypto.randomUUID(),
    quoteHash: "a".repeat(64),
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

export async function observeInventory(
  db: AppDatabase,
  scope: ExecutionScope = "confidential",
  amountUnits = "10000",
): Promise<void> {
  const syncToken = await beginInventorySync(db, "owner", scope);
  await finishInventorySync(db, "owner", {
    scope,
    syncToken,
    balances: [{ assetId: "nep141:usdc.test-fixture.near", amountUnits }],
  });
}

export async function startTestSubmission(
  db: AppDatabase,
  actionId: string,
): Promise<{ token: string; occurredAt: number }> {
  const { token } = await claimExecution(db, "owner", actionId);
  await beginSubmission(db, "owner", actionId, token, {
    payloadHash: "b".repeat(64),
    providerRequestId: crypto.randomUUID(),
  });
  const action = await ownedExecution(db, "owner", actionId);
  if (action.startedAt === null) {
    throw new Error("The fixture did not start submission.");
  }
  return { token, occurredAt: action.startedAt };
}
