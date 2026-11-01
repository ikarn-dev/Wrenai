import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
} from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tradingControls } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { claimExecution, commitSignedExecution } from "@/server/execution/ownership";
import { ownedExecution } from "@/server/execution/records";
import { reserveExecution } from "@/server/execution/reservations";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("the Signer shares the final owner transaction", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
    await fundTestAgent(context.db, context.agentId);
  });
  afterEach(async () => {
    await context.postgres.close();
  });
  it("produces no signature after a stop and returns signatures only after submission state commits", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await claimExecution(context.db, "owner", action.id);
    const sign = vi.fn(() => Buffer.from("offline fixture signature"));
    await context.db
      .insert(tradingControls)
      .values({ userId: "owner", killSwitch: true, updatedAt: Date.now() });
    const submission = { payloadHash: "b".repeat(64), providerRequestId: crypto.randomUUID() };
    await expect(
      commitSignedExecution(context.db, "owner", action.id, worker.token, submission, sign),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(sign).not.toHaveBeenCalled();
    await context.db
      .update(tradingControls)
      .set({ killSwitch: false })
      .where(eq(tradingControls.userId, "owner"));
    const signature = await commitSignedExecution(
      context.db,
      "owner",
      action.id,
      worker.token,
      submission,
      sign,
    );
    expect(signature.toString()).toBe("offline fixture signature");
    expect((await ownedExecution(context.db, "owner", action.id)).status).toBe("submitting");
    await expect(
      commitSignedExecution(context.db, "owner", action.id, worker.token, submission, sign),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("rolls back the submission when signing fails", async () => {
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const worker = await claimExecution(context.db, "owner", action.id);
    await expect(
      commitSignedExecution(
        context.db,
        "owner",
        action.id,
        worker.token,
        { payloadHash: "b".repeat(64), providerRequestId: crypto.randomUUID() },
        () => {
          throw new Error("offline signing failure");
        },
      ),
    ).rejects.toThrow("offline signing failure");
    expect((await context.db.select().from(executionActions))[0]?.status).toBe("reserved");
    expect((await ownedExecution(context.db, "owner", action.id)).payloadHash).toBeNull();
  });
});
