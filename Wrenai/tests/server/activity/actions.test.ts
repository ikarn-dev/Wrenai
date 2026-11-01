import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadActivity } from "@/server/activity/actions";
import { readActivityPage } from "@/server/activity/service";
import { currentUser } from "@/server/auth/session";
import { consumeRateLimit } from "@/server/http/rate-limit";

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({ currentUser: vi.fn() }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: vi.fn() }));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("@/server/activity/service", () => ({ readActivityPage: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentUser).mockResolvedValue({ id: "owner", accountId: "owner.near" });
  vi.mocked(consumeRateLimit).mockResolvedValue("allowed");
});
describe("activity access boundary", () => {
  it("requires a signed-in user before any history read", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    expect(await loadActivity({ filter: "all", cursor: null })).toMatchObject({
      ok: false,
      code: "signed_out",
    });
    expect(readActivityPage).not.toHaveBeenCalled();
  });
  it("rejects malformed input and rate-limits before provider calls", async () => {
    expect(await loadActivity({ filter: "all", cursor: { ownerId: "stranger" } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    vi.mocked(consumeRateLimit).mockResolvedValue("limited");
    expect(await loadActivity({ filter: "all", cursor: null })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(readActivityPage).not.toHaveBeenCalled();
    vi.mocked(consumeRateLimit).mockResolvedValue("unavailable");
    expect(await loadActivity({ filter: "all", cursor: null })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
  it("does not send provider errors or credentials to the client", async () => {
    vi.mocked(readActivityPage).mockRejectedValue(new Error("private credential and provider payload"));
    const result = await loadActivity({ filter: "all", cursor: null });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
