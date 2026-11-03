import { createSecretKey } from "node:crypto";
import { perpsTestContext } from "@tests/server/execution/hyperliquid/db-context";
import { fixtureAsset } from "@tests/server/execution/hyperliquid/fixtures";
import { executionTestContext, observeInventory } from "@tests/server/execution/test-context";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionInventory } from "@/server/db/execution-schema";
import { delegatedKeys } from "@/server/db/schema";
import { settleDefiExecution } from "@/server/execution/defi-accounting";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { reserveDefiExecution } from "@/server/execution/defi-reservations";
import { perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import {
  beginInventorySync,
  finishInventorySync,
  observedInventoryBalance,
} from "@/server/execution/inventory";
import { markInventoryUncertain } from "@/server/execution/inventory-state";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { confirmExecutionPermission } from "@/server/execution/permissions";
import { ownedLedgerAction } from "@/server/execution/records";
import { readSpendingUsage } from "@/server/execution/usage";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
let context: Awaited<ReturnType<typeof executionTestContext>> | undefined;
afterEach(async () => {
  if (context) {
    await context.postgres.close();
  }
});
async function partial(asset: string, units: string): Promise<void> {
  if (!context) {
    throw new Error("Missing inventory fixture.");
  }
  const syncToken = await beginInventorySync(context.db, "owner", "hyperliquid", [asset]);
  await finishInventorySync(
    context.db,
    "owner",
    { scope: "hyperliquid", syncToken, balances: [{ assetId: asset, amountUnits: units }] },
    [asset],
  );
}
describe("derived-address observation leases and funding across balance locations", () => {
  it("refreshes two addresses concurrently without presenting an unobserved account as zero", async () => {
    context = await executionTestContext();
    const a = "hyperliquid:usdc:account-a",
      b = "hyperliquid:usdc:account-b";
    const first = await beginInventorySync(context.db, "owner", "hyperliquid", [a]);
    const second = await beginInventorySync(context.db, "owner", "hyperliquid", [b]);
    await expect(beginInventorySync(context.db, "owner", "hyperliquid", [a])).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(beginInventorySync(context.db, "owner", "hyperliquid")).rejects.toMatchObject({
      code: "conflict",
    });
    await finishInventorySync(
      context.db,
      "owner",
      { scope: "hyperliquid", syncToken: second, balances: [{ assetId: b, amountUnits: "200" }] },
      [b],
    );
    await expect(
      observedInventoryBalance(context.db, "owner", "hyperliquid", a, Date.now()),
    ).rejects.toMatchObject({ code: "not_ready" });
    await finishInventorySync(
      context.db,
      "owner",
      { scope: "hyperliquid", syncToken: first, balances: [{ assetId: a, amountUnits: "100" }] },
      [a],
    );
    expect(await observedInventoryBalance(context.db, "owner", "hyperliquid", b, Date.now())).toBe(200n);
    expect(await observedInventoryBalance(context.db, "owner", "hyperliquid", a, Date.now())).toBe(100n);
    await expect(
      observedInventoryBalance(context.db, "owner", "hyperliquid", "unobserved", Date.now()),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
  it("rejects stale takeover tokens and undeclared address coverage", async () => {
    context = await executionTestContext();
    const asset = "hyperliquid:usdc:account-a",
      old = await beginInventorySync(context.db, "owner", "hyperliquid", [asset]);
    await context.db
      .update(executionInventory)
      .set({ syncExpiresAt: Date.now() - 1 })
      .where(eq(executionInventory.assetId, asset));
    const fresh = await beginInventorySync(context.db, "owner", "hyperliquid", [asset]);
    await expect(
      finishInventorySync(context.db, "owner", { scope: "hyperliquid", syncToken: old, balances: [] }, [
        asset,
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      finishInventorySync(
        context.db,
        "owner",
        { scope: "hyperliquid", syncToken: fresh, balances: [{ assetId: "foreign", amountUnits: "999" }] },
        [asset],
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await finishInventorySync(context.db, "owner", { scope: "hyperliquid", syncToken: fresh, balances: [] }, [
      asset,
    ]);
    expect(await observedInventoryBalance(context.db, "owner", "hyperliquid", asset, Date.now())).toBe(0n);
  });
  it("transfers principal once and retains the hold until both locations show the confirmed units", async () => {
    const perps = await perpsTestContext();
    context = perps;
    const cash = perpsCashAssetId(perps.account.perpAddress);
    await partial(cash, "0");
    const [key] = await perps.db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    if (!key) {
      throw new Error("Missing shared authorization.");
    }
    const permissionHash = await confirmExecutionPermission(perps.db, "owner", {
      agentId: perps.agentId,
      agentRevision: 1,
      strategyVersion: 1,
      scope: "confidential",
      venueId: "confidential-intents",
      signingPublicKey: key.publicKey,
      operations: ["transfer"],
      assetIds: [fixtureAsset, cash],
      instruments: [],
      recipients: [perps.account.perpAddress],
      expiresAt: null,
    });
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId: crypto.randomUUID(),
      agentId: perps.agentId,
      agentRevision: 1,
      strategyVersion: 1,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      funding: true,
      scope: "confidential",
      operation: "transfer",
      venueId: "confidential-intents",
      permissionHash,
      cash: [
        { assetId: fixtureAsset, maxDebitUnits: "20000000", minCreditUnits: "0" },
        { scope: "hyperliquid", assetId: cash, maxDebitUnits: "0", minCreditUnits: "19900000" },
      ],
      positions: [],
      notionalMicroUsd: "20000000",
      slippageBps: 50,
      providerFeeBps: 0,
      quoteId: "offline-bridge",
      quoteHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      recipient: perps.account.perpAddress,
      expiresAt: Date.now() + 120000,
    });
    await expect(
      reserveDefiExecution(perps.db, "owner", {
        ...plan,
        recipient: "0x2222222222222222222222222222222222222222",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const action = await reserveDefiExecution(perps.db, "owner", plan),
      worker = await claimExecution(perps.db, "owner", action.id);
    const stale = await beginInventorySync(perps.db, "owner", "hyperliquid", [cash]);
    await beginSubmission(perps.db, "owner", action.id, worker.token, {
      payloadHash: plan.payloadHash,
      providerRequestId: crypto.randomUUID(),
    });
    await expect(
      finishInventorySync(perps.db, "owner", { scope: "hyperliquid", syncToken: stale, balances: [] }, [
        cash,
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    await settleDefiExecution(perps.db, "owner", action.id, worker.token, {
      providerEventId: "offline-confirmed-bridge",
      riskDebitMicroUsd: "20000000",
      feeMicroUsd: null,
      cash: [
        {
          assetId: fixtureAsset,
          debitUnits: "20000000",
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
        {
          assetId: cash,
          debitUnits: "0",
          creditUnits: "19900000",
          creditValueMicroUsd: "19900000",
          creditPrincipalMicroUsd: "19900000",
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: "100000",
      borrowedCapitalMicroUsd: "0",
      occurredAt: Date.now(),
    });
    await observeInventory(perps.db, "confidential", "0");
    expect((await ownedLedgerAction(perps.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    await partial(cash, "0");
    expect((await ownedLedgerAction(perps.db, "owner", action.id)).reservationReleasedAt).toBeNull();
    await partial(cash, "19900000");
    expect((await ownedLedgerAction(perps.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
    expect(
      (await readSpendingUsage(perps.db, "owner", perps.agentId, Date.now())).agentSpent24hMicroUsd,
    ).toBe(0n);
    const token = await beginInventorySync(perps.db, "owner", "hyperliquid", [cash]);
    await markInventoryUncertain(perps.db, action);
    await expect(
      finishInventorySync(perps.db, "owner", { scope: "hyperliquid", syncToken: token, balances: [] }, [
        cash,
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await perps.db
          .select()
          .from(executionInventory)
          .where(and(eq(executionInventory.scope, "hyperliquid"), eq(executionInventory.assetId, cash)))
      )[0]?.observedAt,
    ).toBeNull();
  });
});
