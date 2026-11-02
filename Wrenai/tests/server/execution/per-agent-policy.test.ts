import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
} from "@tests/server/execution/test-context";
import { describe, expect, it, vi } from "vitest";
import { userRiskPolicies } from "@/server/db/risk-schema";
import { claimExecution } from "@/server/execution/ownership";
import { reserveExecution } from "@/server/execution/reservations";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";

vi.mock("server-only", () => ({}));
describe("new per-agent policy without any global configuration", () => {
  it("reserves and claims owned inventory using only agent limits and rejects legacy unbound actions", async () => {
    const context = await executionTestContext({}, {}, false);
    try {
      await observeInventory(context.db);
      await fundTestAgent(context.db, context.agentId);
      expect(await context.db.select().from(userRiskPolicies)).toHaveLength(0);
      const plan = executionPlan(context.agentId, { budgetMode: "per_agent", riskPolicyRevision: 0 });
      const action = await reserveExecution(context.db, "owner", plan);
      expect((await claimExecution(context.db, "owner", action.id)).mode).toBe("submit");
      await expect(
        reserveExecution(context.db, "owner", executionPlan(context.agentId)),
      ).rejects.toMatchObject({ code: "not_ready" });
      await expect(
        setAgentCapitalLimit(context.db, "owner", {
          requestId: crypto.randomUUID(),
          agentId: context.agentId,
          amountMicroUsd: "1",
        }),
      ).rejects.toMatchObject({ code: "limit" });
    } finally {
      await context.postgres.close();
    }
  });
});
