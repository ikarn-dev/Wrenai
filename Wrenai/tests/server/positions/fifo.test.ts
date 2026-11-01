import {
  executionPlan,
  executionTestContext,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { assignTestInventory, observeTestAssets, TEST_ASSET } from "@tests/server/positions/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { positionDisposals, positionLots, positionRealizations } from "@/server/db/position-schema";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import { reserveExecution } from "@/server/execution/reservations";
import { assignInventory } from "@/server/positions/attribution";
import { proportionalCost } from "@/server/positions/lots";
import { readAgentPositions } from "@/server/positions/report";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("FIFO performance accounting and principal conservation", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("consumes FIFO across lots and uses net received valuation without subtracting fees twice", async () => {
    await assignTestInventory(context.db, context.agentId, "1000", "2000000");
    await assignTestInventory(context.db, context.agentId, "1000", "4000000");
    const action = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "1500" }),
    );
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "fifo-crossing",
      inputUnits: "1500",
      outputUnits: "150",
      inputValueMicroUsd: "9000000",
      outputValueMicroUsd: "8000000",
      feeMicroUsd: "1000000",
      occurredAt: worker.occurredAt,
    });
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.realizedPnlMicroUsd).toBe(4_000_000n);
    expect(report.attributedPrincipalMicroUsd).toBe(6_000_000n);
    expect(report.positions.find((position) => position.assetId === TEST_ASSET)).toMatchObject({
      attributedUnits: 500n,
      costBasisMicroUsd: 2_000_000n,
    });
    expect(report.positions.find((position) => position.assetId === action.outputAssetId)).toMatchObject({
      attributedUnits: 150n,
      costBasisMicroUsd: 8_000_000n,
    });
    const disposals = await context.db
      .select({
        quantityUnits: positionDisposals.quantityUnits,
        basisMicroUsd: positionDisposals.basisMicroUsd,
      })
      .from(positionDisposals)
      .innerJoin(positionLots, eq(positionLots.id, positionDisposals.lotId))
      .orderBy(positionLots.sequence);
    expect(disposals.map((disposal) => disposal.quantityUnits)).toEqual([1000n, 500n]);
    expect(disposals.map((disposal) => disposal.basisMicroUsd)).toEqual([2_000_000n, 2_000_000n]);
  });

  it("records losses as signed amounts", async () => {
    await assignTestInventory(context.db, context.agentId, "1000", "5000000");
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "loss",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "4000000",
      outputValueMicroUsd: "3000000",
      feeMicroUsd: "1000000",
      occurredAt: worker.occurredAt,
    });
    expect((await readAgentPositions(context.db, "owner", context.agentId)).realizedPnlMicroUsd).toBe(
      -2_000_000n,
    );
  });

  it.each(["missing-output-value", "missing-input-basis"] as const)(
    "keeps PnL unavailable for %s",
    async (missing) => {
      await assignTestInventory(
        context.db,
        context.agentId,
        "1000",
        "5000000",
        missing === "missing-input-basis" ? null : "5000000",
      );
      const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
      const worker = await startTestSubmission(context.db, action.id);
      await recordExecutionFill(context.db, "owner", action.id, worker.token, {
        providerEventId: missing,
        inputUnits: "1000",
        outputUnits: "100",
        inputValueMicroUsd: "5000000",
        ...(missing === "missing-output-value" ? {} : { outputValueMicroUsd: "4000000" }),
        feeMicroUsd: "0",
        occurredAt: worker.occurredAt,
      });
      const report = await readAgentPositions(context.db, "owner", context.agentId);
      expect(report.realizedPnlMicroUsd).toBeNull();
      expect(report.unpricedRealizations).toBe(1);
      expect(report.positions[0]?.attributedUnits).toBe(100n);
      if (missing === "missing-output-value") {
        expect(report.positions[0]?.costBasisMicroUsd).toBeNull();
      }
    },
  );

  it("never consumes a lot or credits output twice on receipt recovery", async () => {
    await assignTestInventory(context.db, context.agentId);
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    const receipt = {
      providerEventId: "same-fill",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "1000000",
      outputValueMicroUsd: "1000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    };
    await recordExecutionFill(context.db, "owner", action.id, worker.token, receipt);
    await context.db
      .update(executionActions)
      .set({ leaseExpiresAt: 0 })
      .where(eq(executionActions.id, action.id));
    await recordExecutionFill(context.db, "owner", action.id, worker.token, receipt);
    expect(await context.db.select().from(positionLots)).toHaveLength(2);
    expect(await context.db.select().from(positionRealizations)).toHaveLength(1);
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.realizedPnlMicroUsd).toBe(0n);
    expect(report.realizationCount).toBe(1);
    expect(
      (await readAgentPositions(context.db, "owner", context.agentId)).positions[0]?.attributedUnits,
    ).toBe(100n);
  });

  it("consumes lots in actual receipt order rather than binding old lots to the first reserved action", async () => {
    await assignTestInventory(context.db, context.agentId, "1000", "2000000");
    await assignTestInventory(context.db, context.agentId, "1000", "4000000");
    const first = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const second = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const b = await startTestSubmission(context.db, second.id);
    await recordExecutionFill(context.db, "owner", second.id, b.token, {
      providerEventId: "second-reserved-first-filled",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "3000000",
      outputValueMicroUsd: "3000000",
      feeMicroUsd: "0",
      occurredAt: b.occurredAt,
    });
    await settleExecution(context.db, "owner", second.id, b.token, {
      providerReceiptId: "second-terminal",
      refundedInputUnits: "0",
    });
    await observeInventory(context.db, "confidential", "9000");
    const a = await startTestSubmission(context.db, first.id);
    await recordExecutionFill(context.db, "owner", first.id, a.token, {
      providerEventId: "first-reserved-second-filled",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "5000000",
      outputValueMicroUsd: "5000000",
      feeMicroUsd: "0",
      occurredAt: a.occurredAt,
    });
    const realized = await context.db
      .select({
        providerEventId: executionFills.providerEventId,
        basisMicroUsd: positionRealizations.basisMicroUsd,
      })
      .from(positionRealizations)
      .innerJoin(executionFills, eq(executionFills.id, positionRealizations.fillId));
    expect(
      realized.find((row) => row.providerEventId === "second-reserved-first-filled")?.basisMicroUsd,
    ).toBe(2_000_000n);
    expect(
      realized.find((row) => row.providerEventId === "first-reserved-second-filled")?.basisMicroUsd,
    ).toBe(4_000_000n);
  });

  it("rounds partial basis conservatively and preserves every unit of basis/principal on close", async () => {
    expect(proportionalCost(1n, 1n, 3n)).toBe(1n);
    await assignTestInventory(context.db, context.agentId, "3", "1");
    const action = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputUnits: "3", minOutputUnits: "3" }),
    );
    const worker = await startTestSubmission(context.db, action.id);
    for (const id of ["dust-1", "dust-2", "dust-3"]) {
      await recordExecutionFill(context.db, "owner", action.id, worker.token, {
        providerEventId: id,
        inputUnits: "1",
        outputUnits: "1",
        inputValueMicroUsd: "1",
        outputValueMicroUsd: "1",
        feeMicroUsd: "0",
        occurredAt: worker.occurredAt,
      });
    }
    const disposals = await context.db.select().from(positionDisposals);
    expect(disposals.reduce((sum, row) => sum + (row.basisMicroUsd ?? 0n), 0n)).toBe(1n);
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.attributedPrincipalMicroUsd).toBe(1n);
    expect(report.realizedPnlMicroUsd).toBe(2n);
  });

  it("allows independently funded unrelated assets while another order remains unresolved", async () => {
    await assignTestInventory(context.db, context.agentId);
    const first = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await startTestSubmission(context.db, first.id);
    const other = "nep141:unrelated.near";
    await observeTestAssets(context.db, [
      { assetId: TEST_ASSET, amountUnits: "10000" },
      { assetId: other, amountUnits: "2000" },
    ]);
    await assignInventory(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "confidential",
      assetId: other,
      quantityUnits: "2000",
      capitalMicroUsd: "2000000",
      costBasisMicroUsd: "2000000",
      sourceReference: "offline-unrelated",
      evidenceHash: "c".repeat(64),
    });
    const second = await reserveExecution(
      context.db,
      "owner",
      executionPlan(context.agentId, { inputAssetId: other, outputAssetId: "nep141:other-output.near" }),
    );
    await startTestSubmission(context.db, second.id);
    const rows = await context.db.select().from(executionActions);
    expect(
      rows.every((action) => action.status === "submitting" && action.reservationReleasedAt === null),
    ).toBe(true);
  });

  it("protects original lot facts, disposals and realizations from direct DML edits", async () => {
    const lotId = await assignTestInventory(context.db, context.agentId);
    await expect(
      context.db.update(positionLots).set({ initialUnits: 1001n }).where(eq(positionLots.id, lotId)),
    ).rejects.toThrow();
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "protected-history",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "1000000",
      outputValueMicroUsd: "1000000",
      feeMicroUsd: "0",
      occurredAt: worker.occurredAt,
    });
    await expect(context.db.delete(positionDisposals)).rejects.toThrow();
    await expect(context.db.update(positionRealizations).set({ realizedPnlMicroUsd: 1n })).rejects.toThrow();
  });
});
