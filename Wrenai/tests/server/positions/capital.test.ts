import { executionPlan, executionTestContext, observeInventory } from "@tests/server/execution/test-context";
import { readAgentPositions } from "@tests/server/positions/report";
import {
  addTestAgent,
  allocateTestAgent,
  assignTestInventory,
  observeTestAssets,
  TEST_ASSET,
} from "@tests/server/positions/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteIfNothingHeld } from "@/server/agents/agent-return";
import { commandAgent } from "@/server/agents/mutations";
import { agents } from "@/server/db/agent-schema";
import { agentCapital, capitalAccounts, capitalEvents, positionLots } from "@/server/db/position-schema";
import { delegatedKeys } from "@/server/db/schema";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { cancelReservedExecution, reserveExecution } from "@/server/execution/reservations";
import { assignInventory, releaseInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit, setUserCapitalLimit } from "@/server/positions/capital-limits";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof executionTestContext>>;
describe("owner capital allocation and attributed inventory", () => {
  beforeEach(async () => {
    context = await executionTestContext();
    await observeInventory(context.db);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("does not require delegated key setup for capital settings", async () => {
    await context.db.delete(delegatedKeys);
    await setUserCapitalLimit(context.db, "owner", {
      requestId: crypto.randomUUID(),
      amountMicroUsd: "200000000",
    });
    await setAgentCapitalLimit(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      amountMicroUsd: "50000000",
    });
    expect((await readAgentPositions(context.db, "owner", context.agentId)).capitalCeilingMicroUsd).toBe(
      50_000_000n,
    );
  });

  it("derives the capital summary from individual ceilings without using it as a shared user limit", async () => {
    await setUserCapitalLimit(context.db, "owner", {
      requestId: crypto.randomUUID(),
      amountMicroUsd: "100000000",
    });
    await setAgentCapitalLimit(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      amountMicroUsd: "60000000",
    });
    const second = await addTestAgent(context.db);
    await allocateTestAgent(context.db, second, "40000001");
    expect((await context.db.select().from(capitalAccounts))[0]?.limitMicroUsd).toBe(100_000_001n);
    await allocateTestAgent(context.db, second, "40000000");
    await expect(
      setUserCapitalLimit(context.db, "owner", {
        requestId: crypto.randomUUID(),
        amountMicroUsd: "99999999",
      }),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("serializes concurrent independent ceilings while deriving the correct total", async () => {
    await allocateTestAgent(context.db, context.agentId, "0");
    await setUserCapitalLimit(context.db, "owner", {
      requestId: crypto.randomUUID(),
      amountMicroUsd: "100000000",
    });
    const second = await addTestAgent(context.db);
    const results = await Promise.allSettled([
      allocateTestAgent(context.db, context.agentId, "60000000"),
      allocateTestAgent(context.db, second, "60000000"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await context.db.select().from(capitalAccounts))[0]?.limitMicroUsd).toBe(120_000_000n);
  });

  it("replays identical allocation requests and rejects changed request payloads", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "confidential",
      assetId: TEST_ASSET,
      quantityUnits: "1000",
      capitalMicroUsd: "1000000",
      costBasisMicroUsd: "1000000",
      sourceReference: "offline-source",
      evidenceHash: "c".repeat(64),
    };
    const id = await assignInventory(context.db, "owner", input);
    expect(await assignInventory(context.db, "owner", input)).toBe(id);
    await expect(
      assignInventory(context.db, "owner", { ...input, quantityUnits: "1001" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(positionLots)).toHaveLength(1);
  });

  it("never attributes the same wallet units to two agents", async () => {
    await assignTestInventory(context.db, context.agentId, "7000", "7000000");
    const second = await addTestAgent(context.db);
    await allocateTestAgent(context.db, second);
    await expect(assignTestInventory(context.db, second, "3001", "3001000")).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    await assignTestInventory(context.db, second, "3000", "3000000");
    expect((await readAgentPositions(context.db, "owner", second)).positions[0]?.attributedUnits).toBe(3000n);
  });

  it("refuses to spend another agent's attributed holdings", async () => {
    await assignTestInventory(context.db, context.agentId, "10000", "10000000");
    const second = await addTestAgent(context.db);
    await allocateTestAgent(context.db, second);
    await expect(reserveExecution(context.db, "owner", executionPlan(second))).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    expect((await readAgentPositions(context.db, "owner", context.agentId)).positions[0]?.reservedUnits).toBe(
      1000n,
    );
    await cancelReservedExecution(context.db, "owner", action.id);
    expect((await readAgentPositions(context.db, "owner", context.agentId)).positions[0]?.reservedUnits).toBe(
      0n,
    );
  });

  it("does not release reserved holdings or reduce a ceiling below attributed principal", async () => {
    await assignTestInventory(context.db, context.agentId, "10000", "10000000");
    await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await expect(
      releaseInventory(context.db, "owner", {
        requestId: crypto.randomUUID(),
        agentId: context.agentId,
        scope: "confidential",
        assetId: TEST_ASSET,
        quantityUnits: "9001",
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    await expect(allocateTestAgent(context.db, context.agentId, "9999999")).rejects.toMatchObject({
      code: "limit",
    });
  });

  it("releases unreserved attribution idempotently without recording a trading profit", async () => {
    await assignTestInventory(context.db, context.agentId);
    const release = {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "confidential",
      assetId: TEST_ASSET,
      quantityUnits: "1000",
    };
    await releaseInventory(context.db, "owner", release);
    await releaseInventory(context.db, "owner", release);
    await allocateTestAgent(context.db, context.agentId, "0");
    const report = await readAgentPositions(context.db, "owner", context.agentId);
    expect(report.attributedPrincipalMicroUsd).toBe(0n);
    expect(report.realizedPnlMicroUsd).toBeNull();
    expect(report.realizationCount).toBe(0);
    expect(report.positions).toHaveLength(0);
  });

  it("isolates owners and aggregates attributed principal across scopes", async () => {
    await allocateTestAgent(context.db, context.agentId, "10000000");
    await assignTestInventory(context.db, context.agentId, "1000", "6000000");
    await observeInventory(context.db, "intents", "10000");
    const input = {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "intents",
      assetId: TEST_ASSET,
      quantityUnits: "1000",
      capitalMicroUsd: "4000001",
      costBasisMicroUsd: "4000001",
      sourceReference: "offline-public",
      evidenceHash: "c".repeat(64),
    };
    await expect(assignInventory(context.db, "owner", input)).rejects.toMatchObject({ code: "limit" });
    await expect(assignInventory(context.db, "stranger", input)).rejects.toMatchObject({ code: "not_found" });
    await expect(readAgentPositions(context.db, "stranger", context.agentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await assignInventory(context.db, "owner", { ...input, capitalMicroUsd: "4000000" });
    expect((await readAgentPositions(context.db, "owner", context.agentId)).attributedPrincipalMicroUsd).toBe(
      10_000_000n,
    );
  });

  it("rechecks a lowered capital ceiling before starting an already-reserved action", async () => {
    await assignTestInventory(context.db, context.agentId, "10000", "10000000");
    const action = await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    await reserveExecution(context.db, "owner", executionPlan(context.agentId));
    const lease = await claimExecution(context.db, "owner", action.id);
    await allocateTestAgent(context.db, context.agentId, "10000000");
    await expect(
      beginSubmission(context.db, "owner", action.id, lease.token, {
        payloadHash: "b".repeat(64),
        providerRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("prevents silent writeoff/reassignment after an observed wallet shortfall", async () => {
    await assignTestInventory(context.db, context.agentId);
    await observeTestAssets(context.db, [{ assetId: TEST_ASSET, amountUnits: "500" }]);
    await expect(
      releaseInventory(context.db, "owner", {
        requestId: crypto.randomUUID(),
        agentId: context.agentId,
        scope: "confidential",
        assetId: TEST_ASSET,
        quantityUnits: "1000",
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(
      (await readAgentPositions(context.db, "owner", context.agentId)).positions[0]?.attributedUnits,
    ).toBe(1000n);
  });

  it("keeps a deleted agent until its attributed funds are gone and preserves capital audit rows", async () => {
    await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
    await assignTestInventory(context.db, context.agentId);
    const user = { id: "owner", accountId: "owner.near" };
    await commandAgent(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      expectedRevision: 1,
      command: "delete",
    });
    expect(await deleteIfNothingHeld(context.db, user, context.agentId)).toBe(false);
    const [returning] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
    expect(returning).toMatchObject({ status: "stopped", deletedAt: null });
    expect(returning?.deleteRequestedAt).not.toBeNull();
    await releaseInventory(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      scope: "confidential",
      assetId: TEST_ASSET,
      quantityUnits: "1000",
    });
    expect(await deleteIfNothingHeld(context.db, user, context.agentId)).toBe(true);
    const [deleted] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
    expect(deleted?.deletedAt).not.toBeNull();
    expect(
      await context.db.select().from(agentCapital).where(eq(agentCapital.agentId, context.agentId)),
    ).toEqual([expect.objectContaining({ limitMicroUsd: 0n })]);
    await expect(context.db.update(capitalEvents).set({ detailJson: "{}" })).rejects.toThrow();
    expect(await context.db.select().from(capitalEvents)).not.toHaveLength(0);
  });
});
