import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export function telegramConfig(): { readonly botToken: string; readonly webhookSecret: string } | null {
  const parsed = configSchema.safeParse(process.env);
  return parsed.success
    ? { botToken: parsed.data.TELEGRAM_BOT_TOKEN, webhookSecret: parsed.data.TELEGRAM_WEBHOOK_SECRET }
    : null;
}
export function linkToken(userId: string, challengeId: string): string {
  const config = telegramConfig();
  if (config === null) {
    throw new AgentError("unavailable", "Telegram linking is not configured yet.");
  }
  return createHmac("sha256", config.webhookSecret)
    .update(`wrenai-telegram-link:v1\0${userId}\0${challengeId}`)
    .digest("base64url");
}
export function validWebhookSecret(provided: string | null): boolean {
  const config = telegramConfig();
  if (config === null || provided === null || provided.length > 256) {
    return false;
  }
  const actual = Buffer.from(provided);
  const expected = Buffer.from(config.webhookSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Read-only Bot API lookup. Never propagate fetch errors whose URL could contain the bot token. */
export async function telegramBotUsername(): Promise<string> {
  const config = telegramConfig();
  if (config === null) {
    throw new AgentError("unavailable", "Telegram linking is not configured yet.");
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new AgentError("unavailable", "Telegram could not verify the bot. Try again shortly.");
    }
    const parsed = z
      .object({
        ok: z.literal(true),
        result: z.object({
          is_bot: z.literal(true),
          username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
        }),
      })
      .safeParse(await response.json());
    if (!parsed.success) {
      throw new AgentError("unavailable", "Telegram could not verify the bot. Try again shortly.");
    }
    return parsed.data.result.username;
  } catch (error) {
    if (error instanceof AgentError) {
      throw error;
    }
    throw new AgentError("unavailable", "Telegram is unavailable. Try again shortly.");
  }
}
