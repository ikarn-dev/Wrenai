import { z } from "zod";
import { telegramIdentitySchema } from "@/shared/telegram";

const updateSchema = z.object({
  update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: z
    .object({
      text: z.string().max(4096).optional(),
      from: telegramIdentitySchema.optional(),
      chat: z.object({
        id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
        type: z.string(),
      }),
    })
    .optional(),
});
export interface TelegramStart {
  readonly token: string;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly firstName: string;
  readonly username: string | null;
}

/** Ignore unrelated updates, groups, bots and messages that do not belong to the sending private user. */
export function parseTelegramStart(raw: unknown): TelegramStart | null {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const message = parsed.data.message;
  if (message?.from === undefined || message.chat.type !== "private" || message.chat.id !== message.from.id) {
    return null;
  }
  const match = /^\/start link_([A-Za-z0-9_-]{43})$/.exec(message.text ?? "");
  const token = match?.[1];
  return token === undefined
    ? null
    : {
        token,
        telegramUserId: String(message.from.id),
        chatId: String(message.chat.id),
        firstName: message.from.first_name,
        username: message.from.username ?? null,
      };
}
