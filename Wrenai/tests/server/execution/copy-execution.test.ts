import { executionTestContext } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { planStrategyCheck } from "@/server/engine/planning";
import { prepareAgentRuntime, readAgentRuntime } from "@/server/engine/runtime";
import { currentAgentStrategy } from "@/server/execution/asset-review";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
});
afterEach(async () => {
  await context.postgres.close();
});
describe("retired executable families", () => {
  it.each(["copy_trading", "rebalancer"] as const)(
    "cannot plan new %s trades while historical records remain readable",
    async (pack) => {
      await context.db.update(agents).set({ pack, status: "paused" }).where(eq(agents.id, context.agentId));
      const id = await prepareAgentRuntime(context.db, "owner", {
        requestId: crypto.randomUUID(),
        agentId: context.agentId,
        expectedRevision: 1,
        command: "resume",
      });
      const runtime = await readAgentRuntime(context.db, id);
      if (!runtime) {
        throw new Error("Missing fixture runtime");
      }
      const current = await currentAgentStrategy(context.db, "owner", context.agentId, 1);
      await expect(
        planStrategyCheck(context.db, current, runtime, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(await context.db.select().from(executionActions)).toHaveLength(0);
      expect(current.agent.pack).toBe(pack);
    },
  );
});
