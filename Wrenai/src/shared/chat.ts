import { z } from "zod";
import { inferenceModelSchema } from "@/shared/ai-models";
import { MAX_WALLET_TOKEN_DECIMALS, walletAssetSchema } from "./agent-budget";
import { chatQuoteRequestSchema } from "./chat-quote";
import { researchReportSchema, researchToolSchema } from "./research";
import { walletSwapViewSchema } from "./wallet-swap";

export const MAX_CHAT_MESSAGE = 8_000;
export const MAX_CHAT_TURNS = 100;
export const MAX_CHAT_CONTEXT_TURNS = 24;
export const MAX_CHAT_CONVERSATIONS = 100;

export const chatInputSchema = z.strictObject({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  previousTurnId: z.uuid().nullable(),
  message: z.string().trim().min(1, "Write a message first.").max(MAX_CHAT_MESSAGE),
  includeContext: z.boolean(),
  tool: researchToolSchema.nullable().optional(),
});
export type ChatInput = z.infer<typeof chatInputSchema>;

export const chatReceiptSchema = z.strictObject({
  model: inferenceModelSchema,
  completionId: z.string().min(1),
  signatureKind: z.literal("provider_tee"),
  verifiedAt: z.number().int().positive(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const chatContextSchema = z.strictObject({
  readAt: z.number().int().positive(),
  accountId: z.string(),
  wallet: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("balance"), near: z.string(), readAt: z.number() }),
    z.strictObject({ kind: z.literal("no_account"), readAt: z.number() }),
    z.strictObject({ kind: z.literal("unavailable") }),
  ]),
  // Older encrypted replies contain the native wallet reading only.
  walletHoldings: z
    .strictObject({
      coverage: z.enum(["complete", "partial", "unavailable"]),
      tokens: z.array(
        z.strictObject({
          assetId: walletAssetSchema,
          symbol: z.string().min(1).max(64),
          balance: z.string().max(MAX_WALLET_TOKEN_DECIMALS + 2),
          available: z
            .string()
            .max(MAX_WALLET_TOKEN_DECIMALS + 2)
            .nullable(),
        }),
      ),
    })
    .optional(),
  agents: z
    .array(z.strictObject({ name: z.string(), pack: z.string(), status: z.string(), updatedAt: z.number() }))
    .max(50),
  agentsTruncated: z.boolean(),
});
export type ChatContext = z.infer<typeof chatContextSchema>;

export const chatReplySchema = z
  .strictObject({
    manual: z
      .strictObject({
        text: z.string().max(800),
        tradeIds: z.array(z.uuid()).max(1),
        /** Swaps paid from the wallet (wallet_swaps), shown as wallet swap cards. */
        walletSwapIds: z.array(z.uuid()).max(1).optional(),
        quoteRequest: chatQuoteRequestSchema.optional(),
      })
      .optional(),
    content: z.string().min(1).max(32_000),
    receipt: chatReceiptSchema.nullable(),
    context: chatContextSchema.nullable(),
    historyTrimmed: z.boolean(),
    research: z.array(researchReportSchema).max(6).optional(),
  })
  .refine(
    (reply) => reply.receipt !== null || (reply.manual !== undefined && !reply.research?.length),
    "A model answer requires verification evidence.",
  );
export type ChatReply = z.infer<typeof chatReplySchema>;

export const chatTurnSchema = z.strictObject({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  message: z.string(),
  includeContext: z.boolean(),
  tool: researchToolSchema.nullable().optional(),
  state: z.enum(["pending", "complete", "failed", "cancelled"]),
  reply: chatReplySchema.nullable(),
  createdAt: z.number().int().positive(),
});
export type ChatTurn = z.infer<typeof chatTurnSchema>;

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly revision?: number;
}

export interface Conversation extends ConversationSummary {
  readonly turns: readonly ChatTurn[];
  readonly hasEarlier?: boolean;
}

export const conversationSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  updatedAt: z.number().int().positive(),
  revision: z.number().int().positive(),
});
export const CHAT_PAGE_SIZE = 20;
export const conversationPageSchema = conversationSummarySchema.extend({
  turns: z.array(chatTurnSchema).max(CHAT_PAGE_SIZE),
  hasEarlier: z.boolean(),
});
export type ConversationPage = z.infer<typeof conversationPageSchema>;
export const chatPageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  beforeSequence: z.number().int().positive().nullable().default(null),
});

export const chatEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), message: z.string().max(160) }),
  z.strictObject({ type: z.literal("turn"), turn: chatTurnSchema }),
  z.strictObject({ type: z.literal("delta"), text: z.string().max(32_000) }),
  z.strictObject({ type: z.literal("research"), reports: z.array(researchReportSchema).max(6) }),
  z.strictObject({ type: z.literal("verified") }),
  z.strictObject({ type: z.literal("reset") }),
  z.strictObject({
    type: z.literal("done"),
    turn: chatTurnSchema,
    walletSwap: walletSwapViewSchema.optional(),
    quoteError: z.string().max(40).optional(),
  }),
  z.strictObject({ type: z.literal("title"), title: z.string().min(1).max(72) }),
  z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string().max(500) }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

export type ChatFailureCode =
  | "signed_out"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "verification_failed"
  | "cancelled";

export type ChatResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ChatFailureCode; readonly message: string };

export const chatFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "signed_out",
    "invalid_input",
    "not_found",
    "conflict",
    "rate_limited",
    "unavailable",
    "verification_failed",
    "cancelled",
  ]),
  message: z.string(),
});
export const chatResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: chatTurnSchema }),
  chatFailureSchema,
]);
