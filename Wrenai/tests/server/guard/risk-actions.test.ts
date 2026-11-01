import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userRiskPolicies } from "@/server/db/risk-schema";
import { readAccountRiskPolicy, saveAccountRiskPolicy } from "@/server/guard/risk-actions";
import type { UserRiskPolicy } from "@/shared/risk-policy";

const calls = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), database: vi.fn(), refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: calls.refresh }));
vi.mock("@/server/auth/session", () => ({ currentUser: calls.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: calls.rate }));
vi.mock("@/server/db/client", () => ({ database: calls.database }));

let context: Awaited<ReturnType<typeof testDatabase>>;
function request(): { requestId: string; expectedRevision: number; policy: UserRiskPolicy } {
  return {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    policy: { dailyCapUsd: "10.000001" },
  };
}

describe("account risk settings Server Actions", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    context = await testDatabase();
    calls.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    calls.rate.mockResolvedValue("allowed");
    calls.database.mockReturnValue(context.db);
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("requires a session for reads and writes without changing stored policies", async () => {
    calls.user.mockResolvedValue(null);
    expect(await readAccountRiskPolicy({})).toMatchObject({ ok: false, code: "signed_out" });
    expect(await saveAccountRiskPolicy(request())).toMatchObject({ ok: false, code: "signed_out" });
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(0);
  });

  it.each(["limited", "unavailable"] as const)(
    "fails closed when shared request protection is %s",
    async (decision) => {
      calls.rate.mockResolvedValue(decision);
      const code = decision === "limited" ? "rate_limited" : "unavailable";
      expect(await saveAccountRiskPolicy(request())).toMatchObject({ ok: false, code });
      expect(await readAccountRiskPolicy({})).toMatchObject({ ok: false, code });
      expect(await context.db.select().from(userRiskPolicies)).toHaveLength(0);
    },
  );

  it("persists the authenticated owner's exact policy and never accepts another owner", async () => {
    expect(await readAccountRiskPolicy({})).toEqual({ ok: true, value: null });
    expect(await saveAccountRiskPolicy(request())).toMatchObject({ ok: true, value: { revision: 1 } });
    const [row] = await context.db.select().from(userRiskPolicies);
    expect(row?.userId).toBe("owner");
    expect(row?.dailyCapMicroUsd).toBe(10_000_001n);
    expect(await readAccountRiskPolicy({ userId: "stranger" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await saveAccountRiskPolicy({ userId: "stranger", ...request() })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    calls.user.mockResolvedValue({ id: "stranger", accountId: "stranger.near" });
    expect(await readAccountRiskPolicy({})).toEqual({ ok: true, value: null });
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(1);
  });

  it("returns a typed revision conflict without losing the newer policy", async () => {
    await saveAccountRiskPolicy(request());
    expect(await saveAccountRiskPolicy(request())).toMatchObject({ ok: false, code: "conflict" });
    expect(await readAccountRiskPolicy({})).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(1);
  });

  it("rejects untrusted numeric amounts and extra permissions before writing", async () => {
    expect(
      await saveAccountRiskPolicy({
        ...request(),
        policy: { dailyCapUsd: 10 },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(0);
    expect(calls.refresh).not.toHaveBeenCalled();
  });

  it.each(["{", "{}"])(
    "reports malformed stored policy %s as unavailable, not an input error",
    async (policyJson) => {
      await saveAccountRiskPolicy(request());
      const [row] = await context.db.select().from(userRiskPolicies);
      if (row === undefined) {
        throw new Error("The risk policy fixture was not saved.");
      }
      await context.db
        .insert(userRiskPolicies)
        .values({ ...row, requestId: crypto.randomUUID(), revision: 2, policyJson });
      expect(await readAccountRiskPolicy({})).toMatchObject({ ok: false, code: "unavailable" });
      expect(await saveAccountRiskPolicy({ ...request(), expectedRevision: 2 })).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(await context.db.select().from(userRiskPolicies)).toHaveLength(2);
    },
  );
});
