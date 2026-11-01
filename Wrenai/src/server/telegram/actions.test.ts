import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramConnections, telegramLinkChallenges } from "@/server/db/telegram-schema";
import {
  checkTelegramLink,
  discardTelegramLink,
  disconnectTelegram,
  finishTelegramLink,
  startTelegramLink,
} from "./actions";
import { claimTelegramLink } from "./linking";
import { telegramStart, telegramTestContext, waitingLink } from "./test-context";

const calls = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), database: vi.fn(), refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: calls.refresh }));
vi.mock("@/server/auth/session", () => ({ currentUser: calls.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: calls.rate }));
vi.mock("@/server/db/client", () => ({ database: calls.database }));
let context: Awaited<ReturnType<typeof telegramTestContext>>;
describe("Telegram settings actions are authenticated and owner scoped", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    context = await telegramTestContext();
    calls.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    calls.rate.mockResolvedValue("allowed");
    calls.database.mockReturnValue(context.db);
  });
  afterEach(async () => {
    await context.postgres.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires a session for every operation", async () => {
    calls.user.mockResolvedValue(null);
    const results = await Promise.all([
      checkTelegramLink({}),
      startTelegramLink({}),
      finishTelegramLink({}),
      discardTelegramLink({}),
      disconnectTelegram({}),
    ]);
    expect(results.every((result) => !result.ok && result.code === "signed_out")).toBe(true);
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
    expect(await context.db.select().from(telegramLinkChallenges)).toHaveLength(0);
  });
  it.each(["limited", "unavailable"] as const)(
    "fails closed when request protection is %s",
    async (decision) => {
      calls.rate.mockResolvedValue(decision);
      expect(
        await startTelegramLink({ requestId: crypto.randomUUID(), expectedChallengeId: null }),
      ).toMatchObject({
        ok: false,
        code: decision === "limited" ? "rate_limited" : "unavailable",
      });
      expect(await context.db.select().from(telegramLinkChallenges)).toHaveLength(0);
    },
  );
  it("does not accept owner overrides or let another session confirm or unlink a connection", async () => {
    expect(
      await startTelegramLink({
        userId: "stranger",
        requestId: crypto.randomUUID(),
        expectedChallengeId: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    await claimTelegramLink(context.db, start);
    calls.user.mockResolvedValue({ id: "stranger", accountId: "stranger.near" });
    expect(await checkTelegramLink({})).toEqual({ ok: true, value: { kind: "unlinked" } });
    expect(
      await finishTelegramLink({ challengeId: waiting.challengeId, telegramUserId: start.telegramUserId }),
    ).toMatchObject({ ok: false, code: "conflict" });
    calls.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    expect(
      await finishTelegramLink({ challengeId: waiting.challengeId, telegramUserId: start.telegramUserId }),
    ).toMatchObject({ ok: true, value: { kind: "linked" } });
    calls.user.mockResolvedValue({ id: "stranger", accountId: "stranger.near" });
    await disconnectTelegram({ linkId: waiting.challengeId });
    expect(await context.db.select().from(telegramConnections)).toHaveLength(1);
  });
});
