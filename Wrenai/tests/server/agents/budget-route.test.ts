import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/agents/budget/route";

const access = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({ currentUser: access.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: access.rate }));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("@/server/agents/token-budgets", () => ({
  readWalletBudgets: async (_db: unknown, userId: string) => ({
    accountId: `${userId}.near`,
    tokens: [],
    funded: [],
    note: "Offline wallet",
  }),
}));

const URL = "https://wren.example/api/agents/budget";

describe("navigation-safe wallet budget reads", () => {
  beforeEach(() => {
    access.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    access.rate.mockResolvedValue("allowed");
  });

  it("returns only the signed-in owner's balances with a private response", async () => {
    const response = await GET(new Request(`${URL}?userId=stranger&assetId=native%3Anear`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ ok: true, value: { accountId: "owner.near" } });
  });

  it("enforces sign-in, request limits and a valid asset", async () => {
    access.user.mockResolvedValueOnce(null);
    expect((await GET(new Request(URL))).status).toBe(401);
    access.rate.mockResolvedValueOnce("limited");
    expect((await GET(new Request(URL))).status).toBe(429);
    expect((await GET(new Request(`${URL}?assetId=invalid`))).status).toBe(400);
  });
});
