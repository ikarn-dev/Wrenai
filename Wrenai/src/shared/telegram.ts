import { z } from "zod";

export const telegramIdentitySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  is_bot: z.literal(false),
  first_name: z.string().min(1).max(256),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,32}$/)
    .optional(),
});
export const beginTelegramLinkSchema = z.strictObject({
  requestId: z.uuid(),
  expectedChallengeId: z.uuid().nullable(),
});
export const confirmTelegramLinkSchema = z.strictObject({
  challengeId: z.uuid(),
  telegramUserId: z.string().regex(/^[1-9]\d{0,15}$/),
});
export const cancelTelegramLinkSchema = z.strictObject({ challengeId: z.uuid() });
export const unlinkTelegramSchema = z.strictObject({ linkId: z.uuid() });

export interface TelegramAccount {
  readonly telegramUserId: string;
  readonly firstName: string;
  readonly username: string | null;
}
export type TelegramLinkState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unlinked" }
  | {
      readonly kind: "waiting";
      readonly challengeId: string;
      readonly expiresAt: number;
      readonly linkUrl: string;
    }
  | {
      readonly kind: "confirm";
      readonly challengeId: string;
      readonly expiresAt: number;
      readonly account: TelegramAccount;
    }
  | {
      readonly kind: "linked";
      readonly linkId: string;
      readonly linkedAt: number;
      readonly account: TelegramAccount;
    };
