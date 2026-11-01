import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActivityPage } from "@/server/activity/queries";
import { agentEvents, agents } from "@/server/db/agent-schema";
import { executionReceipts } from "@/server/db/defi-schema";
import {
  executionActions,
  executionEvents,
  executionFills,
  executionWallets,
} from "@/server/db/execution-schema";
import { capitalEvents } from "@/server/db/position-schema";
import { userRiskPolicies } from "@/server/db/risk-schema";
import type { ActivityCursor } from "@/shared/activity";

vi.mock("server-only", () => ({}));
const snapshot = 1_793_000_000_000;
let context: Awaited<ReturnType<typeof testDatabase>>;
function cursor(before: ActivityCursor["app"]["before"] = null): ActivityCursor {
  const position = { next: null, offset: 0, done: false, unavailable: false } as const;
  return {
    format: 1,
    ownerId: "owner",
    filter: "all",
    snapshotAt: snapshot,
    app: { before, done: false, unavailable: false },
    wallet: { transactions: position, tokens: position, nfts: position, intents: position },
  };
}
beforeEach(async () => {
  context = await testDatabase();
  await context.db.insert(agents).values(
    ["owner", "stranger"].map((userId) => ({
      id: `${userId}-agent`,
      userId,
      name: `${userId} agent`,
      pack: "rebalancer" as const,
      status: "paused" as const,
      reason: "",
      policyJson: "invalid-private-policy",
      createdAt: snapshot - 1000,
      updatedAt: snapshot - 100,
      deletedAt: snapshot - 10,
    })),
  );
});
afterEach(async () => {
  await context.postgres.close();
});

describe("owner activity read model", () => {
  it("retains deleted agents without decoding policies, isolates owners, and pages tied timestamps", async () => {
    await context.db.insert(agentEvents).values(
      Array.from({ length: 26 }, (_, i) => ({
        id: `history-${String(i).padStart(2, "0")}`,
        userId: i === 25 ? "stranger" : "owner",
        agentId: i === 25 ? "stranger-agent" : "owner-agent",
        kind: "strategy_saved",
        message: "Strategy saved.",
        detailJson: "private event payload",
        createdAt: snapshot - 1,
      })),
    );
    await context.db.insert(agentEvents).values({
      id: "future",
      userId: "owner",
      agentId: null,
      kind: "stop",
      message: "future",
      detailJson: "{}",
      createdAt: snapshot + 1,
    });
    const first = await appActivityPage(context.db, "owner", cursor());
    expect(first).toHaveLength(21);
    expect(first[0]).toMatchObject({
      id: "agent:history-24",
      agent: { id: "owner-agent", name: "owner agent", deleted: true },
    });
    const last = first[19];
    if (!last) {
      throw new Error("Missing pagination fixture");
    }
    const second = await appActivityPage(context.db, "owner", cursor({ at: last.occurredAt, id: last.id }));
    expect(second.map((row) => row.id)).toEqual([
      "agent:history-04",
      "agent:history-03",
      "agent:history-02",
      "agent:history-01",
      "agent:history-00",
    ]);
    const serialized = JSON.stringify([...first, ...second]);
    expect(serialized).not.toContain("stranger");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("future");
  });
  it("shows recorded fills rather than reservation ceilings and identifies refunds", async () => {
    await context.db.insert(executionWallets).values({ userId: "owner", scope: "intents" });
    await context.db.insert(executionActions).values({
      id: "action",
      userId: "owner",
      agentId: "owner-agent",
      requestId: "request",
      planHash: "a".repeat(64),
      planJson: "private-plan",
      agentRevision: 1,
      strategyVersion: 1,
      policyHash: "b".repeat(64),
      scope: "intents",
      inputAssetId: "nep141:wrap.near",
      outputAssetId: "nep141:usdc.near",
      inputUnits: 10000n,
      minOutputUnits: 1000n,
      notionalMicroUsd: 1000000000n,
      expiresAt: snapshot + 10000,
      status: "settled",
      signingPublicKey: "private-key-reference",
      createdAt: snapshot - 100,
      updatedAt: snapshot - 1,
    });
    expect((await appActivityPage(context.db, "owner", cursor()))[0]?.amount).toBeNull();
    await context.db.insert(executionReceipts).values({
      id: "fill",
      userId: "owner",
      actionId: "action",
      scope: "intents",
      kind: "swap",
      providerEventId: "receipt",
      receiptHash: "c".repeat(64),
      receiptJson: "private-provider-receipt",
      riskDebitMicroUsd: 2000000n,
      recordedAt: snapshot - 4,
    });
    await context.db.insert(executionFills).values({
      id: "fill",
      userId: "owner",
      actionId: "action",
      scope: "intents",
      providerEventId: "receipt",
      receiptHash: "c".repeat(64),
      inputUnits: 1000n,
      outputUnits: 100n,
      inputValueMicroUsd: 2000000n,
      occurredAt: snapshot - 5,
      recordedAt: snapshot - 4,
    });
    const filled = await appActivityPage(context.db, "owner", cursor());
    expect(filled[0]).toMatchObject({
      title: "Swap completed",
      occurredAt: snapshot - 100,
      amount: { microUsd: "2000000", estimated: true },
    });
    expect(JSON.stringify(filled)).not.toContain("private");
    await context.db.insert(executionEvents).values({
      id: "terminal",
      userId: "owner",
      actionId: "action",
      kind: "intents_terminal",
      detailJson: JSON.stringify({ status: "REFUNDED" }),
      createdAt: snapshot - 1,
    });
    expect((await appActivityPage(context.db, "owner", cursor()))[0]).toMatchObject({
      title: "Swap refunded",
      status: "refunded",
      amount: null,
    });
  });
  it("includes account settings and allocations without representing them as wallet transfers", async () => {
    await context.db.insert(capitalEvents).values({
      id: "allocation",
      userId: "owner",
      agentId: "owner-agent",
      requestId: "allocation",
      inputHash: "a".repeat(64),
      kind: "inventory_assigned",
      resourceId: "lot",
      detailJson: "private-attribution",
      recordedAt: snapshot - 2,
    });
    await context.db.insert(userRiskPolicies).values({
      userId: "owner",
      revision: 1,
      requestId: "risk",
      requestHash: "b".repeat(64),
      policyHash: "c".repeat(64),
      policyJson: "private-risk-policy",
      dailyCapMicroUsd: 75000000n,
      createdAt: snapshot - 1,
    });
    const rows = await appActivityPage(context.db, "owner", cursor());
    expect(rows[0]).toMatchObject({
      title: "Daily spending limit updated",
      category: "settings",
      amount: { microUsd: "75000000", estimated: false },
    });
    expect(rows[1]).toMatchObject({ title: "Assets allocated to agent", status: "recorded", amount: null });
    expect(JSON.stringify(rows)).not.toContain("private");
  });
});
