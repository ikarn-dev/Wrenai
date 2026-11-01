import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/telegram/webhook/route";
import { telegramConnections, telegramLinkChallenges } from "@/server/db/telegram-schema";
import { confirmTelegramLink } from "./linking";
import {
  TEST_WEBHOOK_SECRET,
  telegramStart,
  telegramTestContext,
  telegramUpdate,
  waitingLink,
} from "./test-context";

const calls = vi.hoisted(() => ({ database: vi.fn(), rate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ database: calls.database }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: calls.rate }));
let context: Awaited<ReturnType<typeof telegramTestContext>>;
function request(body: string, secret = TEST_WEBHOOK_SECRET): Request {
  return new Request("https://wrenai.example/api/telegram/webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
  });
}

describe("Telegram webhook authentication and replay boundaries", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    context = await telegramTestContext();
    calls.database.mockReturnValue(context.db);
    calls.rate.mockResolvedValue("allowed");
  });
  afterEach(async () => {
    await context.postgres.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects a forged webhook before it can consume a real code", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    expect((await POST(request(JSON.stringify(telegramUpdate(start.token)), "wrong"))).status).toBe(403);
    const [challenge] = await context.db.select().from(telegramLinkChallenges);
    expect(challenge?.claimedAt).toBeNull();
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
  });

  it("accepts private bot proof but still requires authenticated web confirmation", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    const body = JSON.stringify(telegramUpdate(start.token));
    const reply = await POST(request(body));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ method: "sendMessage", chat_id: start.chatId });
    await POST(request(body));
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
    const [challenge] = await context.db.select().from(telegramLinkChallenges);
    expect(challenge?.telegramUserId).toBe(start.telegramUserId);
    await confirmTelegramLink(context.db, "owner", {
      challengeId: waiting.challengeId,
      telegramUserId: start.telegramUserId,
    });
    await POST(request(body));
    expect(await context.db.select().from(telegramConnections)).toHaveLength(1);
  });

  it.each(["group", "supergroup", "channel"])(
    "ignores %s messages even when they contain a valid code",
    async (type) => {
      const waiting = await waitingLink(context.db);
      const token = telegramStart(waiting.challengeId).token;
      const response = await POST(
        request(
          JSON.stringify({
            update_id: 1,
            message: {
              text: `/start link_${token}`,
              from: { id: 42, is_bot: false, first_name: "Fixture" },
              chat: { id: -99, type },
            },
          }),
        ),
      );
      expect(await response.json()).toEqual({ ok: true });
      expect((await context.db.select().from(telegramLinkChallenges))[0]?.claimedAt).toBeNull();
    },
  );

  it.each(["limited", "unavailable"] as const)(
    "does not claim codes when request protection is %s",
    async (decision) => {
      const waiting = await waitingLink(context.db);
      calls.rate.mockResolvedValue(decision);
      const response = await POST(
        request(JSON.stringify(telegramUpdate(telegramStart(waiting.challengeId).token))),
      );
      expect(response.status).toBe(decision === "limited" ? 429 : 503);
      expect((await context.db.select().from(telegramLinkChallenges))[0]?.claimedAt).toBeNull();
    },
  );

  it("bounds request bodies and rejects malformed JSON", async () => {
    expect((await POST(request(" ".repeat(32_769)))).status).toBe(413);
    expect((await POST(request("{"))).status).toBe(400);
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
  });
});
