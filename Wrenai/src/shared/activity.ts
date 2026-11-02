import { z } from "zod";
import { tokenUnitsSchema } from "./token-units";

export const ACTIVITY_PAGE_SIZE = 20;
export const WALLET_STREAMS = ["transactions", "tokens", "nfts", "intents"] as const;
export type WalletActivityStream = (typeof WALLET_STREAMS)[number];
export const activityFilterSchema = z.enum(["all", "wallet", "agents"]);
export type ActivityFilter = z.infer<typeof activityFilterSchema>;
const time = z.number().int().min(1_000_000_000_000).max(9_999_999_999_999);
const providerCursor = z.string().min(1).max(8192);
const walletPosition = z.strictObject({
  next: providerCursor.nullable(),
  offset: z.number().int().min(0).max(ACTIVITY_PAGE_SIZE),
  done: z.boolean(),
  unavailable: z.boolean(),
});
export type WalletActivityPosition = z.infer<typeof walletPosition>;
export const activityCursorSchema = z.strictObject({
  format: z.literal(1),
  ownerId: z.string().min(1).max(128),
  filter: activityFilterSchema,
  snapshotAt: time,
  app: z.strictObject({
    before: z.strictObject({ at: time, id: z.string().min(1).max(200) }).nullable(),
    done: z.boolean(),
    unavailable: z.boolean(),
  }),
  wallet: z.strictObject({
    transactions: walletPosition,
    tokens: walletPosition,
    nfts: walletPosition,
    intents: walletPosition,
  }),
});
export type ActivityCursor = z.infer<typeof activityCursorSchema>;
export const activityRequestSchema = z.strictObject({
  filter: activityFilterSchema,
  cursor: activityCursorSchema.nullable(),
});
export const activityAmountSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("usd"), microUsd: tokenUnitsSchema, estimated: z.boolean() }),
  z.strictObject({
    kind: z.literal("token"),
    units: tokenUnitsSchema,
    decimals: z.number().int().min(0).max(36).nullable(),
    symbol: z.string().min(1).max(32),
    assetId: z.string().min(1).max(256).optional(),
    direction: z.enum(["in", "out", "none"]),
  }),
]);
export type ActivityAmount = z.infer<typeof activityAmountSchema>;
export const activityEntrySchema = z.strictObject({
  id: z.string().min(1).max(200),
  source: z.enum(["wallet", "agents"]),
  category: z.enum(["wallet", "agent", "trade", "funding", "settings", "security"]),
  title: z.string().min(1).max(160),
  description: z.string().max(500),
  status: z.enum(["completed", "pending", "failed", "recorded", "cancelled", "refunded"]),
  occurredAt: time,
  agent: z
    .strictObject({ id: z.string().min(1).max(128), name: z.string().max(160), deleted: z.boolean() })
    .nullable(),
  transactionHash: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
    .nullable(),
  amount: activityAmountSchema.nullable(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export interface ActivityPage {
  readonly items: readonly ActivityEntry[];
  readonly nextCursor: ActivityCursor | null;
  readonly snapshotAt: number;
  readonly unavailable: readonly string[];
}
export type ActivityResult =
  | { readonly ok: true; readonly value: ActivityPage }
  | {
      readonly ok: false;
      readonly code: "signed_out" | "invalid_input" | "rate_limited" | "unavailable";
      readonly message: string;
    };
