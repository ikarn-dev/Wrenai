import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
  startTestSubmission,
} from "@tests/server/execution/test-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordExecutionFill, settleExecution } from "@/server/execution/accounting";
import { readProofReport } from "@/server/execution/proof-report";
import { reserveExecution } from "@/server/execution/reservations";
import { readPortfolioPerformance } from "@/server/portfolio/performance";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  await observeInventory(context.db);
  await fundTestAgent(context.db, context.agentId);
});
afterEach(async () => context.postgres.close());
describe("owner-scoped portfolio evidence", () => {
  it("distinguishes no fills from recorded realized gains and supplies UTC dates", async () => {
    expect((await readPortfolioPerformance(context.db, "owner")).count).toBe(0);
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await startTestSubmission(context.db, action.id);
    await recordExecutionFill(context.db, "owner", action.id, worker.token, {
      providerEventId: "offline-realized",
      inputUnits: "1000",
      outputUnits: "100",
      inputValueMicroUsd: "2000000",
      outputValueMicroUsd: "2000000",
      feeMicroUsd: null,
      occurredAt: Date.now(),
    });
    await settleExecution(context.db, "owner", action.id, worker.token, {
      providerReceiptId: "offline-terminal",
      refundedInputUnits: "0",
    });
    const report = await readPortfolioPerformance(context.db, "owner");
    expect(report.count).toBe(1);
    expect(report.totalMicroUsd).toBe(1000000n);
    expect(report.days[0]?.date).toBe(new Date().toISOString().slice(0, 10));
    expect((await readPortfolioPerformance(context.db, "other")).count).toBe(0);
  });
  it("does not expose other owners' strategy or execution records in Proof", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const own = await readProofReport(context.db, "owner"),
      other = await readProofReport(context.db, "other");
    expect(own.actions[0]?.id).toBe(action.id);
    expect(own.strategies[0]?.receipt).toBeNull();
    expect(other.actions).toEqual([]);
    expect(other.strategies).toEqual([]);
  });
});
