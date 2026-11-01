import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEvents, strategyDrafts, strategyParseJobs } from "@/server/db/agent-schema";
import { testDatabase } from "@/server/db/test-database";
import type { Strategy } from "@/shared/agents";
import { prepareStrategyDraft } from "./drafts";

vi.mock("server-only", () => ({}));
const inference = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@/server/ai/strategy-parser", () => ({ parseAttestedStrategy: inference.parse }));
vi.mock("@/server/db/client", () => ({ database: () => context.db }));

let context: Awaited<ReturnType<typeof testDatabase>>;
const strategy: Strategy = {
  kind: "rebalancer",
  targets: [
    { symbol: "NEAR", weightBps: 5000 },
    { symbol: "USDC", weightBps: 5000 },
  ],
  driftBps: 500,
  intervalSeconds: 300,
};
function verified() {
  return {
    strategy,
    receipt: {
      model: "Qwen/Qwen3.8-27B",
      completionId: "test-completion",
      signatureKind: "provider_tee",
      verifiedAt: Date.now(),
      requestHash: "a".repeat(64),
      responseHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      evidenceJson: "{}",
    },
  };
}
function input() {
  return {
    requestId: crypto.randomUUID(),
    pack: "rebalancer",
    strategyText: "Keep equal NEAR and USDC allocations.",
  } as const;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise is not initialized.");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("distributed strategy review leases", () => {
  beforeEach(async () => {
    context = await testDatabase();
    inference.parse.mockReset();
    inference.parse.mockResolvedValue(verified());
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("distinguishes an active request from conflicting input without duplicating inference", async () => {
    const request = input();
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof verified>>();
    inference.parse.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const first = prepareStrategyDraft("owner", request);
    await started.promise;
    try {
      await expect(prepareStrategyDraft("owner", request)).rejects.toMatchObject({ code: "in_progress" });
      await expect(
        prepareStrategyDraft("owner", { ...request, strategyText: "Use a different allocation strategy." }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(inference.parse).toHaveBeenCalledTimes(1);
    } finally {
      result.resolve(verified());
      await first;
    }
  });

  it("allows takeover after expiry and fences out the original worker", async () => {
    const request = input();
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof verified>>();
    inference.parse.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const first = prepareStrategyDraft("owner", request);
    await started.promise;
    try {
      await context.db
        .update(strategyParseJobs)
        .set({ leaseExpiresAt: 0 })
        .where(eq(strategyParseJobs.requestId, request.requestId));
      const replacement = await prepareStrategyDraft("owner", request);
      const stale = expect(first).rejects.toMatchObject({ code: "conflict" });
      result.resolve(verified());
      await stale;
      expect(await prepareStrategyDraft("owner", request)).toEqual(replacement);
      expect(inference.parse).toHaveBeenCalledTimes(2);
      expect(await context.db.select().from(strategyDrafts)).toHaveLength(1);
      expect(await context.db.select().from(agentEvents)).toHaveLength(1);
      expect(await context.db.select().from(strategyParseJobs)).toHaveLength(0);
    } finally {
      result.resolve(verified());
      await Promise.allSettled([first]);
    }
  });

  it("rejects a result that outlives its lease even without a replacement worker", async () => {
    const request = input();
    inference.parse.mockImplementationOnce(async () => {
      await context.db.update(strategyParseJobs).set({ leaseExpiresAt: 0 });
      return verified();
    });
    await expect(prepareStrategyDraft("owner", request)).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(strategyDrafts)).toHaveLength(0);
    expect(await context.db.select().from(strategyParseJobs)).toHaveLength(0);
    await prepareStrategyDraft("owner", request);
    expect(await context.db.select().from(strategyDrafts)).toHaveLength(1);
  });
});
