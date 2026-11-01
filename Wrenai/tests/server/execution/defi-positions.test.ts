import {
  defiTestContext,
  fixtureUsdc,
  liquidityPlan,
  nativeInventory,
  permissionFixture,
} from "@tests/server/execution/defi-test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { settleDefiExecution } from "@/server/execution/defi-accounting";
import type { DefiPlan, DefiReceipt } from "@/server/execution/defi-contracts";
import { reserveDefiExecution } from "@/server/execution/defi-reservations";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { confirmExecutionPermission } from "@/server/execution/permissions";
import { readSpendingUsage } from "@/server/execution/usage";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { committedCapital } from "@/server/positions/capital-records";
import { readAgentPositions } from "@/server/positions/report";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof defiTestContext>>;

async function borrowPlan(): Promise<DefiPlan> {
  const permissionHash = await confirmExecutionPermission(
    context.db,
    "owner",
    permissionFixture(context.agentId, {
      venueId: "rhea-lending",
      operations: ["borrow", "repay"],
      instruments: [{ kind: "debt", instrumentId: fixtureUsdc, maxUnits: "2000" }],
    }),
  );
  return liquidityPlan(context.db, context.agentId, {
    venueId: "rhea-lending",
    permissionHash,
    operation: "borrow",
    cash: [{ assetId: fixtureUsdc, maxDebitUnits: "0", minCreditUnits: "1000" }],
    notionalMicroUsd: "1000000",
    positions: [
      {
        positionId: crypto.randomUUID(),
        kind: "debt",
        instrumentId: fixtureUsdc,
        expectedVersion: 0,
        beforeUnits: "0",
        minAfterUnits: "1000",
        maxAfterUnits: "1000",
      },
    ],
  });
}
function borrowedReceipt(plan: DefiPlan): DefiReceipt {
  const position = plan.positions[0];
  if (!position) {
    throw new Error("Missing test debt.");
  }
  return {
    providerEventId: "offline-borrow",
    riskDebitMicroUsd: "1000000",
    feeMicroUsd: "0",
    cash: [
      {
        assetId: fixtureUsdc,
        debitUnits: "0",
        creditUnits: "1000",
        creditValueMicroUsd: "1000000",
        creditPrincipalMicroUsd: "1000000",
      },
    ],
    positions: [{ positionId: position.positionId, afterUnits: "1000", principalMicroUsd: "0" }],
    retiredPrincipalMicroUsd: "0",
    borrowedCapitalMicroUsd: "1000000",
    occurredAt: Date.now(),
  };
}
async function start(plan: DefiPlan): Promise<{ id: string; token: string }> {
  const action = await reserveDefiExecution(context.db, "owner", plan);
  const worker = await claimExecution(context.db, "owner", action.id);
  await beginSubmission(context.db, "owner", action.id, worker.token, {
    payloadHash: plan.payloadHash,
    providerRequestId: crypto.randomUUID(),
  });
  return { id: action.id, token: worker.token };
}

describe("debt and derivatives are separate from cash", () => {
  beforeEach(async () => {
    context = await defiTestContext();
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("accounts for borrowing without a fake debit, and counts borrowed proceeds against gross capital", async () => {
    const plan = await borrowPlan();
    const action = await start(plan);
    const receipt = borrowedReceipt(plan);
    await expect(
      settleDefiExecution(context.db, "owner", action.id, action.token, {
        ...receipt,
        borrowedCapitalMicroUsd: "0",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await settleDefiExecution(context.db, "owner", action.id, action.token, receipt);
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.defiPositions[0]).toMatchObject({
      kind: "debt",
      quantityUnits: 1000n,
      principalMicroUsd: 0n,
    });
    expect(report.positions.find((p) => p.assetId === fixtureUsdc)?.attributedUnits).toBe(11000n);
    expect(report.attributedPrincipalMicroUsd).toBe(21_000_000n);
    expect(report.realizedPnlMicroUsd).toBeNull();
    expect(
      (await readSpendingUsage(context.db, "owner", context.agentId, Date.now())).userSpent24hMicroUsd,
    ).toBe(1_000_000n);
    await expect(context.db.update(defiPositions).set({ kind: "collateral" })).rejects.toThrow();
  });

  it("repays and closes the exact debt version without requiring a positive output token", async () => {
    const plan = await borrowPlan();
    const action = await start(plan);
    await settleDefiExecution(context.db, "owner", action.id, action.token, borrowedReceipt(plan));
    await nativeInventory(context.db, "11000");
    const position = plan.positions[0];
    if (!position) {
      throw new Error("Missing test debt.");
    }
    const repay: DefiPlan = {
      ...plan,
      requestId: crypto.randomUUID(),
      operation: "repay",
      cash: [{ assetId: fixtureUsdc, maxDebitUnits: "1000", minCreditUnits: "0" }],
      positions: [
        { ...position, expectedVersion: 1, beforeUnits: "1000", minAfterUnits: "0", maxAfterUnits: "0" },
      ],
    };
    const payment = await start(repay);
    await settleDefiExecution(context.db, "owner", payment.id, payment.token, {
      providerEventId: "offline-repay",
      riskDebitMicroUsd: "1000000",
      feeMicroUsd: "0",
      cash: [
        {
          assetId: fixtureUsdc,
          debitUnits: "1000",
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
      ],
      positions: [{ positionId: position.positionId, afterUnits: "0", principalMicroUsd: "0" }],
      retiredPrincipalMicroUsd: "1000000",
      borrowedCapitalMicroUsd: "0",
      occurredAt: Date.now(),
    });
    expect((await context.db.select().from(defiPositions))[0]).toMatchObject({
      version: 2,
      quantityUnits: 0n,
    });
    expect(
      (await context.db.select().from(executionActions).where(eq(executionActions.id, payment.id)))[0]
        ?.outputAssetId,
    ).toBeNull();
    await nativeInventory(context.db);
    await expect(
      reserveDefiExecution(context.db, "owner", { ...repay, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces reviewed position ceilings independently of per-trade cash amounts", async () => {
    const plan = await borrowPlan();
    const p = plan.positions[0];
    if (!p) {
      throw new Error("Missing test debt.");
    }
    await expect(
      reserveDefiExecution(context.db, "owner", { ...plan, positions: [{ ...p, maxAfterUnits: "2001" }] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      reserveDefiExecution(context.db, "owner", { ...plan, scope: "confidential" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      reserveDefiExecution(context.db, "owner", { ...plan, venueId: "unreviewed-lending" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("holds borrowing capital before submission and records final facts after agent deletion or tighter policy", async () => {
    const plan = await borrowPlan();
    const action = await start(plan);
    expect(await committedCapital(context.db, "owner", context.agentId)).toBe(21_000_000n);
    await expect(
      setAgentCapitalLimit(context.db, "owner", {
        requestId: crypto.randomUUID(),
        agentId: context.agentId,
        amountMicroUsd: "20000000",
      }),
    ).rejects.toMatchObject({ code: "limit" });
    await context.db
      .update(agents)
      .set({
        status: "stopped",
        deletedAt: Date.now(),
        revision: 2,
        policyJson: "invalid historical settings",
      })
      .where(eq(agents.id, context.agentId));
    await settleDefiExecution(context.db, "owner", action.id, action.token, borrowedReceipt(plan));
    expect((await context.db.select().from(defiPositions))[0]?.quantityUnits).toBe(1000n);
    expect(await committedCapital(context.db, "owner", context.agentId)).toBe(21_000_000n);
    await nativeInventory(context.db, "11000");
    expect(await committedCapital(context.db, "owner", context.agentId)).toBe(21_000_000n);
  });

  it("reserves a perp market against opposing orders instead of letting agents silently net", async () => {
    const permissionHash = await confirmExecutionPermission(
      context.db,
      "owner",
      permissionFixture(context.agentId, {
        scope: "hyperliquid",
        venueId: "hyperliquid",
        operations: ["perp_open", "perp_reduce"],
        instruments: [
          { kind: "perp_long", instrumentId: "hyperliquid:NEAR", maxUnits: "1000" },
          { kind: "perp_short", instrumentId: "hyperliquid:NEAR", maxUnits: "1000" },
        ],
      }),
    );
    const plan = await liquidityPlan(context.db, context.agentId, {
      scope: "hyperliquid",
      venueId: "hyperliquid",
      permissionHash,
      operation: "perp_open",
      cash: [{ assetId: fixtureUsdc, maxDebitUnits: "0", minCreditUnits: "0" }],
      positions: [
        {
          positionId: crypto.randomUUID(),
          kind: "perp_long",
          instrumentId: "hyperliquid:NEAR",
          expectedVersion: 0,
          beforeUnits: "0",
          minAfterUnits: "100",
          maxAfterUnits: "100",
        },
      ],
    });
    // A finalized account observation is mandatory even when a derivative needs no new cash debit.
    const { beginInventorySync, finishInventorySync } = await import("@/server/execution/inventory");
    const syncToken = await beginInventorySync(context.db, "owner", "hyperliquid");
    await finishInventorySync(context.db, "owner", { scope: "hyperliquid", syncToken, balances: [] });
    await reserveDefiExecution(context.db, "owner", plan);
    await expect(
      reserveDefiExecution(context.db, "owner", {
        ...plan,
        requestId: crypto.randomUUID(),
        positions: [
          {
            positionId: crypto.randomUUID(),
            kind: "perp_short",
            instrumentId: "hyperliquid:NEAR",
            expectedVersion: 0,
            beforeUnits: "0",
            minAfterUnits: "100",
            maxAfterUnits: "100",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
