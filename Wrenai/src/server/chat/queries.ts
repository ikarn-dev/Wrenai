import "server-only";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { attestationReceiptSchema } from "@/server/ai/attestation-receipt";
import { chatConversations, chatTurns } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import {
  CHAT_PAGE_SIZE,
  type ChatTurn,
  type Conversation,
  type ConversationPage,
  type ConversationSummary,
  chatReplySchema,
  conversationPageSchema,
  MAX_CHAT_CONTEXT_TURNS,
  MAX_CHAT_CONVERSATIONS,
  MAX_CHAT_TURNS,
} from "@/shared/chat";
import { type ChatCipher, chatCipher } from "./cipher";
import { ChatError } from "./errors";
import { openMessage } from "./message-record";
import { readChatCache, writeChatCache } from "./redis-cache";

export const storedReplySchema = z.strictObject({
  reply: chatReplySchema,
  attestation: attestationReceiptSchema,
});
export type TurnRow = typeof chatTurns.$inferSelect;

export function displayTurn(row: TurnRow, cipher: ChatCipher, now = Date.now()): ChatTurn {
  try {
    return {
      id: row.id,
      sequence: row.sequence,
      ...openMessage(cipher, row.userId, row.conversationId, row.id, row.sealedMessage),
      includeContext: row.includeContext,
      state: row.state === "pending" && row.leaseExpiresAt <= now ? "failed" : row.state,
      reply:
        row.sealedReply === null
          ? null
          : storedReplySchema.parse(
              JSON.parse(cipher.open(row.userId, row.conversationId, `${row.id}:assistant`, row.sealedReply)),
            ).reply,
      createdAt: row.createdAt,
    };
  } catch {
    throw new ChatError(
      "unavailable",
      "This conversation could not be decrypted. Check the server encryption key.",
    );
  }
}

function summary(row: typeof chatConversations.$inferSelect, cipher: ChatCipher): ConversationSummary {
  if (row.sealedTitle === null) {
    throw new ChatError("not_found", "Conversation not found.");
  }
  try {
    return {
      id: row.id,
      title: cipher.open(row.userId, row.id, "title", row.sealedTitle),
      updatedAt: row.updatedAt,
      revision: row.revision,
    };
  } catch {
    throw new ChatError(
      "unavailable",
      "Chat history could not be decrypted. Check the server encryption key.",
    );
  }
}

/** Revision validation keeps deletion/retry state authoritative even when Redis holds an older page. */
export async function readConversationPage(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  beforeSequence: number | null,
  cipher: ChatCipher = chatCipher(),
): Promise<ConversationPage> {
  const [header] = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.userId, userId),
        eq(chatConversations.id, conversationId),
        isNull(chatConversations.deletedAt),
      ),
    )
    .limit(1);
  if (!header) {
    throw new ChatError("not_found", "Conversation not found.");
  }
  const stamp = `page:${header.revision}:${beforeSequence ?? "latest"}`;
  const cached = await readChatCache(userId, conversationId, stamp, conversationPageSchema, cipher);
  if (cached) {
    return cached;
  }
  const rows = await db
    .select()
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.userId, userId),
        eq(chatTurns.conversationId, conversationId),
        beforeSequence === null ? undefined : lt(chatTurns.sequence, beforeSequence),
      ),
    )
    .orderBy(desc(chatTurns.sequence))
    .limit(CHAT_PAGE_SIZE + 1);
  const page = conversationPageSchema.parse({
    ...summary(header, cipher),
    hasEarlier: rows.length > CHAT_PAGE_SIZE,
    turns: rows
      .slice(0, CHAT_PAGE_SIZE)
      .reverse()
      .map((row) => displayTurn(row, cipher)),
  });
  // Pending leases change with wall time even without a write; never cache their presentation.
  if (!page.turns.some((turn) => turn.state === "pending")) {
    await writeChatCache(userId, conversationId, stamp, page, cipher);
  }
  return page;
}

export async function listConversations(
  db: AppDatabase,
  userId: string,
  cipher: ChatCipher = chatCipher(),
): Promise<readonly ConversationSummary[]> {
  const rows = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.userId, userId), isNull(chatConversations.deletedAt)))
    .orderBy(desc(chatConversations.updatedAt), asc(chatConversations.id))
    .limit(MAX_CHAT_CONVERSATIONS);
  return rows.map((row) => summary(row, cipher));
}

export async function conversationHistory(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  beforeSequence: number,
  cipher: ChatCipher,
): Promise<readonly ChatTurn[]> {
  const rows = await db
    .select()
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.userId, userId),
        eq(chatTurns.conversationId, conversationId),
        eq(chatTurns.state, "complete"),
        lt(chatTurns.sequence, beforeSequence),
      ),
    )
    .orderBy(desc(chatTurns.sequence))
    // One extra completed turn lets the prompt report that older history was omitted.
    .limit(MAX_CHAT_CONTEXT_TURNS + 1);
  return rows.reverse().map((row) => displayTurn(row, cipher));
}

export async function readConversation(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  cipher: ChatCipher = chatCipher(),
): Promise<Conversation> {
  const rows = await db
    .select({ conversation: chatConversations, turn: chatTurns })
    .from(chatConversations)
    .leftJoin(
      chatTurns,
      and(eq(chatTurns.conversationId, chatConversations.id), eq(chatTurns.userId, chatConversations.userId)),
    )
    .where(
      and(
        eq(chatConversations.userId, userId),
        eq(chatConversations.id, conversationId),
        isNull(chatConversations.deletedAt),
      ),
    )
    .orderBy(asc(chatTurns.sequence))
    .limit(MAX_CHAT_TURNS);
  const row = rows[0]?.conversation;
  if (!row) {
    throw new ChatError("not_found", "Conversation not found.");
  }
  return {
    ...summary(row, cipher),
    turns: rows.flatMap((result) => (result.turn === null ? [] : [displayTurn(result.turn, cipher)])),
  };
}
