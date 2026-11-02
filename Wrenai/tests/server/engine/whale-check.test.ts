import { testDatabase } from "@tests/server/db/test-database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walletActivityPage } from "@/server/activity/wallet";
import { agentEvents, agentRuntimes, agents } from "@/server/db/agent-schema";
import { planWhaleCheck, whaleThresholdMatches } from "@/server/engine/whale-check";
import type { ActivityEntry } from "@/shared/activity";
import { agentInstructionSchema } from "@/shared/agent-instructions";

vi.mock("server-only", () => ({}));
vi.mock("@/server/activity/wallet", () => ({ walletActivityPage: vi.fn() }));
const now = Date.parse("2026-11-02T00:00:00Z");
let context: Awaited<ReturnType<typeof testDatabase>>;
let agentId: string;
function instruction() {
  const rule = agentInstructionSchema.parse({
    format: 2,
    kind: "whale_tracker",
    accounts: ["watched.near"],
    assetIds: ["nep141:unpriced.near"],
    threshold: { type: "token", assetId: "nep141:unpriced.near", amountUnits: "1000000" },
    cooldownSeconds: 60,
    events: ["token_transfer"],
    expiresAt: new Date(now + 3600_000).toISOString(),
  });
  if (rule.kind !== "whale_tracker") {
    throw new Error("Expected watch rule");
  }
  return rule;
}
function event(id: string, amount = "1000000"): ActivityEntry {
  return {
    id,
    source: "wallet",
    category: "wallet",
    title: "Token received",
    description: "From sender.near · unpriced.near",
    status: "recorded",
    occurredAt: now - 1000,
    agent: null,
    transactionHash: "1".repeat(44),
    amount: {
      kind: "token",
      units: amount,
      decimals: 6,
      symbol: "TOKEN",
      assetId: "nep141:unpriced.near",
      direction: "in",
    },
  };
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  context = await testDatabase();
  agentId = crypto.randomUUID();
  await context.db.insert(agents).values({
    id: agentId,
    userId: "owner",
    name: "Watchlist",
    pack: "whale_tracker",
    status: "running",
    reason: "Offline",
    policyJson: "{}",
    createdAt: now - 2000,
    updatedAt: now,
  });
  await context.db.insert(agentRuntimes).values({
    userId: "owner",
    agentId,
    activationId: crypto.randomUUID(),
    inputHash: "a".repeat(64),
    agentRevision: 1,
    strategyVersion: 1,
    state: "active",
    nextCheckAt: now,
    createdAt: now - 2000,
    updatedAt: now,
    leaseToken: "offline-lease",
    leaseExpiresAt: now + 90_000,
  });
  vi.mocked(walletActivityPage)
    .mockReset()
    .mockResolvedValue({ items: [event("wallet-ft:one")], next: null, total: 1 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await context.postgres.close();
});
async function check() {
  const [runtime] = await context.db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.agentId, agentId))
    .limit(1);
  if (!runtime) {
    throw new Error("Missing runtime");
  }
  return planWhaleCheck(context.db, runtime, instruction());
}
describe("durable explicit NEAR watchlists", () => {
  it("records qualifying indexed movements once across polling overlap and restarts", async () => {
    const first = await check();
    expect(first.signal).toBeNull();
    expect(first.progress?.completed).toBe(false);
    const rows = await context.db.select().from(agentEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("whale_alert");
    await context.db
      .update(agentRuntimes)
      .set({ strategyStateJson: JSON.stringify(first.progress?.strategyState) })
      .where(eq(agentRuntimes.agentId, agentId));
    await check();
    expect(await context.db.select().from(agentEvents)).toHaveLength(1);
  });
  it("does not treat ticker matches, failed activity or small transfers as qualifying", async () => {
    const rule = instruction(),
      move = event("one");
    expect(await whaleThresholdMatches(rule, event("small", "999999"))).toBe(false);
    expect(await whaleThresholdMatches(rule, { ...move, status: "failed" })).toBe(false);
    expect(
      await whaleThresholdMatches(rule, {
        ...move,
        amount: {
          kind: "token",
          symbol: "TOKEN",
          assetId: "nep141:spoof.near",
          decimals: 6,
          units: "1000000000",
          direction: "in",
        },
      }),
    ).toBe(false);
    expect(await whaleThresholdMatches(rule, move)).toBe(true);
  });
  it("persists high-volume pagination instead of silently skipping history", async () => {
    vi.mocked(walletActivityPage).mockResolvedValue({
      items: [event("wallet-ft:one")],
      next: "opaque-page-two",
      total: 20,
    });
    const planned = await check();
    if (planned.progress?.strategyState.format !== 4) {
      throw new Error("Expected watch cursor");
    }
    expect(planned.progress.strategyState.cursors[0]?.next).toBe("opaque-page-two");
    expect(planned.progress.strategyState.cursors[0]?.from).toBe(now - 2000);
  });
});
