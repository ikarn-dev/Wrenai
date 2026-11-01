import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotUsername, telegramConfig, validWebhookSecret } from "./config";
import { configureTelegramTest, TEST_WEBHOOK_SECRET, telegramUpdate } from "./test-context";
import { parseTelegramStart } from "./update";

vi.mock("server-only", () => ({}));
describe("Telegram provider boundary", () => {
  beforeEach(() => {
    configureTelegramTest();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("validates the webhook secret without exposing configuration", () => {
    expect(validWebhookSecret(TEST_WEBHOOK_SECRET)).toBe(true);
    expect(validWebhookSecret(null)).toBe(false);
    expect(validWebhookSecret("t".repeat(64))).toBe(false);
    expect(validWebhookSecret("s".repeat(257))).toBe(false);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect(telegramConfig()).toBeNull();
    expect(validWebhookSecret(TEST_WEBHOOK_SECRET)).toBe(false);
  });
  it("verifies bot identity and sanitizes errors whose URLs contain credentials", async () => {
    expect(await telegramBotUsername()).toBe("WrenaiTestBot");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("https://api.telegram.org/botSECRET/getMe"));
    await expect(telegramBotUsername()).rejects.toMatchObject({
      code: "unavailable",
      message: "Telegram is unavailable. Try again shortly.",
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, result: { username: "impostor" } }));
    await expect(telegramBotUsername()).rejects.toMatchObject({ code: "unavailable" });
  });
  it("parses large Telegram IDs exactly and rejects identity/chat mismatches", () => {
    const token = "x".repeat(43);
    expect(parseTelegramStart(telegramUpdate(token, 4_000_000_000_000))?.telegramUserId).toBe(
      "4000000000000",
    );
    expect(
      parseTelegramStart({
        update_id: 1,
        message: {
          text: `/start link_${token}`,
          from: { id: 42, is_bot: false, first_name: "Fixture" },
          chat: { id: 43, type: "private" },
        },
      }),
    ).toBeNull();
    expect(
      parseTelegramStart({
        update_id: 1,
        message: {
          text: `/start link_${token}`,
          from: { id: 42, is_bot: true, first_name: "Bot" },
          chat: { id: 42, type: "private" },
        },
      }),
    ).toBeNull();
    expect(parseTelegramStart({ update_id: 1 })).toBeNull();
  });
});
