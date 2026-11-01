import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strategyVersions } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { reserveExecution } from "./reservations";
import { executionPlan, executionTestContext, fundTestAgent, observeInventory } from "./test-context";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("assets are bounded by the reviewed strategy instead of account Settings", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });
  it("blocks unresolved strategy assets without installing account-wide defaults", async () => {
    await context.db
      .update(strategyVersions)
      .set({ resolvedAssetsJson: null })
      .where(eq(strategyVersions.agentId, context.agentId));
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "not_ready" },
    );
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });
  it("rejects bindings copied from a different strategy", async () => {
    await context.db
      .update(strategyVersions)
      .set({
        resolvedAssetsJson: JSON.stringify({
          strategyHash: "f".repeat(64),
          assets: [
            { symbol: "NEAR", assetId: "nep141:wrap.near" },
            { symbol: "USDC", assetId: "nep141:usdc.test-fixture.near" },
            { symbol: "BTC", assetId: "nep141:other-output.near" },
            { symbol: "USDT", assetId: "nep141:unrelated.near" },
          ],
        }),
      })
      .where(eq(strategyVersions.agentId, context.agentId));
    await expect(reserveExecution(context.db, "owner", executionPlan(context.agentId))).rejects.toMatchObject(
      { code: "not_ready" },
    );
  });
  it("does not let the plan add an asset to its own permissions", async () => {
    await expect(
      reserveExecution(context.db, "owner", {
        ...executionPlan(context.agentId),
        allowedAssetIds: ["nep141:unapproved.near"],
      }),
    ).rejects.toThrow();
    await expect(
      reserveExecution(
        context.db,
        "owner",
        executionPlan(context.agentId, { outputAssetId: "nep141:unapproved.near" }),
      ),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
  });
});
