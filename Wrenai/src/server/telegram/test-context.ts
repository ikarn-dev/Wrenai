import { vi } from "vitest";
import { testDatabase } from "@/server/db/test-database";
import type { TelegramLinkState } from "@/shared/telegram";
import { linkToken } from "./config";
import { beginTelegramLink } from "./linking";
import type { TelegramStart } from "./update";

export const TEST_WEBHOOK_SECRET = "s".repeat(64);
export function configureTelegramTest(): void {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:offline_telegram_bot_token_for_tests");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ ok: true, result: { is_bot: true, username: "WrenaiTestBot" } }),
      ),
  );
}
export async function telegramTestContext(): Promise<Awaited<ReturnType<typeof testDatabase>>> {
  configureTelegramTest();
  return testDatabase();
}
export async function waitingLink(
  db: Awaited<ReturnType<typeof testDatabase>>["db"],
  userId = "owner",
): Promise<Extract<TelegramLinkState, { readonly kind: "waiting" }>> {
  const state = await beginTelegramLink(db, userId, {
    requestId: crypto.randomUUID(),
    expectedChallengeId: null,
  });
  if (state.kind !== "waiting") {
    throw new Error("The Telegram fixture did not create a waiting link.");
  }
  return state;
}
export function telegramStart(
  challengeId: string,
  userId = "owner",
  telegramUserId = "1234567890123",
): TelegramStart {
  return {
    token: linkToken(userId, challengeId),
    telegramUserId,
    chatId: telegramUserId,
    firstName: "Offline Telegram User",
    username: "offline_user",
  };
}
export function telegramUpdate(token: string, id = 1234567890123): unknown {
  return {
    update_id: 1,
    message: {
      text: `/start link_${token}`,
      from: { id, is_bot: false, first_name: "Offline User" },
      chat: { id, type: "private" },
    },
  };
}
