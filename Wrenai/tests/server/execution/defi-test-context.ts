import { executionTestContext } from "@tests/server/execution/test-context";
import type { AppDatabase } from "@/server/db/client";
import type { DefiPlan, DefiReceipt, ExecutionPermission } from "@/server/execution/defi-contracts";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { confirmExecutionPermission } from "@/server/execution/permissions";
import { assignInventory } from "@/server/positions/attribution";

export const fixtureUsdc = "nep141:usdc.test-fixture.near";
export const fixtureNear = "nep141:wrap.near";
export async function nativeInventory(db: AppDatabase, amount = "10000"): Promise<void> {
  const syncToken = await beginInventorySync(db, "owner", "native_near");
  await finishInventorySync(db, "owner", {
    scope: "native_near",
    syncToken,
    balances: [fixtureUsdc, fixtureNear].map((assetId) => ({ assetId, amountUnits: amount })),
  });
}
export async function defiTestContext(): Promise<Awaited<ReturnType<typeof executionTestContext>>> {
  const context = await executionTestContext();
  await nativeInventory(context.db);
  for (const assetId of [fixtureUsdc, fixtureNear]) {
    await assignInventory(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "native_near",
      assetId,
      quantityUnits: "10000",
      capitalMicroUsd: "10000000",
      costBasisMicroUsd: "10000000",
      sourceReference: "offline-defi-allocation",
      evidenceHash: "c".repeat(64),
    });
  }
  return context;
}
export function permissionFixture(
  agentId: string,
  overrides: Partial<ExecutionPermission> = {},
): ExecutionPermission {
  return {
    agentId,
    agentRevision: 1,
    strategyVersion: 1,
    scope: "native_near",
    venueId: "rhea-amm",
    signingPublicKey: "ed25519:offline-only-key",
    operations: ["add_liquidity", "remove_liquidity"],
    assetIds: [fixtureUsdc, fixtureNear],
    instruments: [{ kind: "lp_share", instrumentId: "rhea-pool:offline-0", maxUnits: "100000" }],
    recipients: [],
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}
export async function liquidityPlan(
  db: AppDatabase,
  agentId: string,
  overrides: Partial<DefiPlan> = {},
): Promise<DefiPlan> {
  const permissionHash = await confirmExecutionPermission(db, "owner", permissionFixture(agentId));
  return {
    format: 2,
    requestId: crypto.randomUUID(),
    agentId,
    agentRevision: 1,
    strategyVersion: 1,
    riskPolicyRevision: 1,
    scope: "native_near",
    venueId: "rhea-amm",
    operation: "add_liquidity",
    permissionHash,
    cash: [
      { assetId: fixtureUsdc, maxDebitUnits: "1000", minCreditUnits: "0" },
      { assetId: fixtureNear, maxDebitUnits: "2000", minCreditUnits: "0" },
    ],
    positions: [
      {
        positionId: crypto.randomUUID(),
        kind: "lp_share",
        instrumentId: "rhea-pool:offline-0",
        expectedVersion: 0,
        beforeUnits: "0",
        minAfterUnits: "99",
        maxAfterUnits: "101",
      },
    ],
    notionalMicroUsd: "10000000",
    slippageBps: 50,
    providerFeeBps: 0,
    quoteId: "offline-lp-quote",
    quoteHash: "a".repeat(64),
    payloadHash: "b".repeat(64),
    recipient: null,
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}
export function liquidityReceipt(plan: DefiPlan, overrides: Partial<DefiReceipt> = {}): DefiReceipt {
  const position = plan.positions[0];
  if (!position) {
    throw new Error("Missing test position.");
  }
  return {
    providerEventId: "offline-lp-final",
    riskDebitMicroUsd: "3000000",
    feeMicroUsd: "0",
    cash: [
      {
        assetId: fixtureUsdc,
        debitUnits: "1000",
        creditUnits: "0",
        creditValueMicroUsd: null,
        creditPrincipalMicroUsd: "0",
      },
      {
        assetId: fixtureNear,
        debitUnits: "2000",
        creditUnits: "0",
        creditValueMicroUsd: null,
        creditPrincipalMicroUsd: "0",
      },
    ],
    positions: [{ positionId: position.positionId, afterUnits: "100", principalMicroUsd: "3000000" }],
    retiredPrincipalMicroUsd: "0",
    borrowedCapitalMicroUsd: "0",
    occurredAt: Date.now(),
    ...overrides,
  };
}
