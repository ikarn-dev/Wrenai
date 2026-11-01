import { testDatabase } from "@tests/server/db/test-database";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userRiskPolicies } from "@/server/db/risk-schema";
import { executionHash } from "@/server/execution/records";
import { readUserRiskPolicy, setUserRiskPolicy } from "@/server/guard/user-policy";
import { saveUserRiskPolicySchema, type UserRiskPolicy } from "@/shared/risk-policy";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof testDatabase>>;
const policy: UserRiskPolicy = {
  dailyCapUsd: "20.000001",
};
function request(expectedRevision = 0): {
  requestId: string;
  expectedRevision: number;
  policy: UserRiskPolicy;
} {
  return { requestId: crypto.randomUUID(), expectedRevision, policy };
}

describe("owner-controlled account-wide risk policies", () => {
  beforeEach(async () => {
    context = await testDatabase();
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("has no implicit limits and can be configured before agents or authorization exist", async () => {
    expect(await readUserRiskPolicy(context.db, "owner")).toBeNull();
    const saved = await setUserRiskPolicy(context.db, "owner", request());
    expect(saved.revision).toBe(1);
    expect(saved.policy).toEqual(policy);
    const [row] = await context.db.select().from(userRiskPolicies);
    expect(row?.dailyCapMicroUsd).toBe(20_000_001n);
    expect(await readUserRiskPolicy(context.db, "stranger")).toBeNull();
  });

  it("replays an identical request without rewriting history", async () => {
    const input = request();
    const saved = await setUserRiskPolicy(context.db, "owner", input);
    expect(await setUserRiskPolicy(context.db, "owner", input)).toEqual(saved);
    await expect(
      setUserRiskPolicy(context.db, "owner", {
        ...input,
        policy: { ...policy, dailyCapUsd: "21" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(1);
  });

  it("retains previous revisions and rejects a stale settings write", async () => {
    const first = request();
    await setUserRiskPolicy(context.db, "owner", first);
    const next = { ...request(1), policy: { dailyCapUsd: "1" } };
    expect((await setUserRiskPolicy(context.db, "owner", next)).revision).toBe(2);
    await expect(setUserRiskPolicy(context.db, "owner", request(1))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await readUserRiskPolicy(context.db, "owner"))?.policy.dailyCapUsd).toBe("1");
    expect((await setUserRiskPolicy(context.db, "owner", first)).revision).toBe(1);
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(2);
  });

  it("serializes competing changes without losing one owner's revision", async () => {
    const results = await Promise.allSettled([
      setUserRiskPolicy(context.db, "owner", request()),
      setUserRiskPolicy(context.db, "owner", request()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await context.db.select().from(userRiskPolicies)).toHaveLength(1);
  });

  it("isolates owner policies and idempotency keys", async () => {
    const input = request();
    await setUserRiskPolicy(context.db, "owner", input);
    const other = { ...input, policy: { ...policy, dailyCapUsd: "5" } };
    await setUserRiskPolicy(context.db, "stranger", other);
    expect((await readUserRiskPolicy(context.db, "owner"))?.policy.dailyCapUsd).toBe("20.000001");
    expect((await readUserRiskPolicy(context.db, "stranger"))?.policy.dailyCapUsd).toBe("5");
  });

  it("rejects malformed amounts, ambiguous permissions and extra authority fields", () => {
    for (const dailyCapUsd of ["0", "-1", "1e6", "1.0000001"]) {
      expect(
        saveUserRiskPolicySchema.safeParse({ ...request(), policy: { ...policy, dailyCapUsd } }).success,
      ).toBe(false);
    }
    for (const allowedAssetIds of [[], ["NEAR"], ["nep141:*"], ["nep141:wrap.near", " nep141:wrap.near "]]) {
      expect(
        saveUserRiskPolicySchema.safeParse({ ...request(), policy: { ...policy, allowedAssetIds } }).success,
      ).toBe(false);
    }
    expect(saveUserRiskPolicySchema.safeParse({ ...request(), userId: "stranger" }).success).toBe(false);
    expect(
      saveUserRiskPolicySchema.safeParse({ ...request(), policy: { ...policy, allowedChains: ["*"] } })
        .success,
    ).toBe(false);
  });

  it("enforces positive caps and revisions in SQL and rejects historical mutation", async () => {
    await setUserRiskPolicy(context.db, "owner", request());
    const [row] = await context.db.select().from(userRiskPolicies);
    if (row === undefined) {
      throw new Error("The policy fixture was not stored.");
    }
    await expect(
      context.db.insert(userRiskPolicies).values({
        ...row,
        requestId: crypto.randomUUID(),
        revision: 2,
        dailyCapMicroUsd: 0n,
      }),
    ).rejects.toThrow();
    await expect(
      context.db.insert(userRiskPolicies).values({
        ...row,
        requestId: crypto.randomUUID(),
        revision: 0,
      }),
    ).rejects.toThrow();
    await expect(context.db.update(userRiskPolicies).set({ policyJson: "{}" })).rejects.toThrow();
    await expect(
      context.db.delete(userRiskPolicies).where(eq(userRiskPolicies.userId, "owner")),
    ).rejects.toThrow();
    await expect(context.db.execute(sql`TRUNCATE user_risk_policies`)).rejects.toThrow();
    expect((await readUserRiskPolicy(context.db, "owner"))?.revision).toBe(1);
  });

  it("reads historical policy hashes without exposing obsolete token/chain selectors or rewriting history", async () => {
    const historical = {
      dailyCapUsd: "20.000001",
      allowedAssetIds: ["nep141:wrap.near"],
      allowedChains: ["near"],
    };
    await context.db.insert(userRiskPolicies).values({
      userId: "owner",
      revision: 1,
      requestId: crypto.randomUUID(),
      requestHash: "a".repeat(64),
      policyHash: executionHash(historical),
      policyJson: JSON.stringify(historical),
      dailyCapMicroUsd: 20_000_001n,
      createdAt: 1,
    });
    expect((await readUserRiskPolicy(context.db, "owner"))?.policy).toEqual(policy);
    await setUserRiskPolicy(context.db, "owner", request(1));
    const rows = await context.db.select().from(userRiskPolicies).orderBy(userRiskPolicies.revision);
    expect(rows[0]?.policyJson).toBe(JSON.stringify(historical));
    expect(rows[1]?.policyJson).toBe(JSON.stringify(policy));
  });
});
