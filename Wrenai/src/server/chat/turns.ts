import "server-only";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AttestationReceipt } from "@/server/ai/attestation-receipt";
import { chatConversations, chatTurns } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import {
  type ChatInput,
  type ChatReply,
  type ChatTurn,
  MAX_CHAT_CONVERSATIONS,
  MAX_CHAT_TURNS,
} from "@/shared/chat";
import { shortChatTitle } from "@/shared/chat-title";
import { type ChatCipher, chatCipher } from "./cipher";
import { ChatError } from "./errors";
import { sealMessage } from "./message-record";
import { displayTurn, storedReplySchema, type TurnRow } from "./queries";

const LEASE_MS = 120_000;
export type ChatClaim =
  | { readonly kind: "cached"; readonly turn: ChatTurn }
  | {
      readonly kind: "claimed";
      readonly token: string;
      readonly turn: ChatTurn;
      readonly historyTip: string | null;
    };

async function touchConversation(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  now: number,
): Promise<void> {
  await db
    .update(chatConversations)
    .set({ updatedAt: now, revision: sql`${chatConversations.revision} + 1` })
    .where(and(eq(chatConversations.userId, userId), eq(chatConversations.id, conversationId)));
}

function turnHash(input: ChatInput, cipher: ChatCipher): string {
  return cipher.hash(
    JSON.stringify([
      input.conversationId,
      input.previousTurnId,
      input.message,
      input.includeContext,
      ...(input.tool ? [input.tool] : []),
    ]),
  );
}

async function ensureConversation(
  db: AppDatabase,
  userId: string,
  input: ChatInput,
  cipher: ChatCipher,
  now: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, input.conversationId))
    .limit(1);
  if (existing) {
    if (existing.userId !== userId || existing.deletedAt !== null) {
      throw new ChatError("not_found", "Conversation not found.");
    }
    return;
  }
  if (input.previousTurnId !== null) {
    throw new ChatError("not_found", "Conversation not found.");
  }
  const owned = await db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(and(eq(chatConversations.userId, userId), isNull(chatConversations.deletedAt)))
    .limit(MAX_CHAT_CONVERSATIONS);
  if (owned.length >= MAX_CHAT_CONVERSATIONS) {
    throw new ChatError("invalid_input", "You have 100 saved chats. Delete a chat before creating another.");
  }
  const [created] = await db
    .insert(chatConversations)
    .values({
      id: input.conversationId,
      userId,
      sealedTitle: cipher.seal(userId, input.conversationId, "title", shortChatTitle(input.message)),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: chatConversations.id });
  if (!created) {
    throw new ChatError("conflict", "This conversation changed. Reload it before sending.");
  }
}

async function updateExisting(
  db: AppDatabase,
  row: TurnRow,
  input: ChatInput,
  cipher: ChatCipher,
  last: TurnRow | undefined,
  now: number,
  cancel: boolean,
): Promise<ChatClaim> {
  if (row.inputHash !== turnHash(input, cipher)) {
    throw new ChatError("conflict", "This message ID was already used. Reload the conversation.");
  }
  if (row.state === "complete" || row.state === "cancelled") {
    return { kind: "cached", turn: displayTurn(row, cipher, now) };
  }
  if (last?.id !== row.id) {
    throw new ChatError("conflict", "Newer messages exist. Send a new message instead of retrying this one.");
  }
  if (!cancel && row.state === "pending" && row.leaseExpiresAt > now) {
    throw new ChatError("conflict", "A reply is already in progress. Check this conversation shortly.");
  }
  const token = crypto.randomUUID();
  const [updated] = await db
    .update(chatTurns)
    .set({ state: cancel ? "cancelled" : "pending", leaseToken: token, leaseExpiresAt: now + LEASE_MS })
    .where(and(eq(chatTurns.userId, row.userId), eq(chatTurns.id, row.id)))
    .returning();
  if (!updated) {
    throw new ChatError("not_found", "Message not found.");
  }
  await touchConversation(db, row.userId, row.conversationId, now);
  return cancel
    ? { kind: "cached", turn: displayTurn(updated, cipher, now) }
    : { kind: "claimed", token, turn: displayTurn(updated, cipher, now), historyTip: null };
}

/** Owner lock, request hash and fencing token prevent duplicate/late replies across tabs and function instances. */
export async function claimChatTurn(
  db: AppDatabase,
  userId: string,
  input: ChatInput,
  options: { readonly cipher?: ChatCipher; readonly now?: number; readonly cancel?: boolean } = {},
): Promise<ChatClaim> {
  const cipher = options.cipher ?? chatCipher();
  const now = options.now ?? Date.now();
  return userTransaction(db, userId, async (tx) => {
    await ensureConversation(tx, userId, input, cipher, now);
    const latestId = tx
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(and(eq(chatTurns.userId, userId), eq(chatTurns.conversationId, input.conversationId)))
      .orderBy(desc(chatTurns.sequence))
      .limit(1);
    const related = await tx
      .select()
      .from(chatTurns)
      .where(
        and(eq(chatTurns.userId, userId), or(eq(chatTurns.id, input.requestId), eq(chatTurns.id, latestId))),
      )
      .orderBy(desc(chatTurns.sequence));
    const last = related.find((row) => row.conversationId === input.conversationId);
    const existing = related.find((row) => row.id === input.requestId);
    if (existing) {
      return updateExisting(tx, existing, input, cipher, last, now, options.cancel ?? false);
    }
    if ((last?.id ?? null) !== input.previousTurnId) {
      throw new ChatError("conflict", "This conversation has newer messages. Reload before sending.");
    }
    if (last?.state === "pending" && last.leaseExpiresAt > now) {
      throw new ChatError("conflict", "A reply is already in progress. Stop it or wait before sending.");
    }
    const sequence = (last?.sequence ?? 0) + 1;
    if (sequence > MAX_CHAT_TURNS) {
      throw new ChatError(
        "invalid_input",
        "This chat has reached 100 messages. Start a new chat to continue.",
      );
    }
    const token = crypto.randomUUID();
    const [row] = await tx
      .insert(chatTurns)
      .values({
        id: input.requestId,
        userId,
        conversationId: input.conversationId,
        sequence,
        inputHash: turnHash(input, cipher),
        sealedMessage: sealMessage(cipher, userId, input),
        sealedReply: null,
        includeContext: input.includeContext,
        state: options.cancel ? "cancelled" : "pending",
        leaseToken: token,
        leaseExpiresAt: now + LEASE_MS,
        createdAt: now,
      })
      .returning();
    if (!row) {
      throw new ChatError("unavailable", "The message could not be saved. Try again.");
    }
    await touchConversation(tx, userId, input.conversationId, now);
    return options.cancel
      ? { kind: "cached", turn: displayTurn(row, cipher, now) }
      : {
          kind: "claimed",
          token,
          turn: displayTurn(row, cipher, now),
          historyTip: last?.state === "complete" ? last.id : null,
        };
  });
}

export async function finishChatTurn(
  db: AppDatabase,
  userId: string,
  input: ChatInput,
  token: string,
  outcome:
    | { readonly state: "failed" | "cancelled" }
    | { readonly state: "complete"; readonly reply: ChatReply; readonly receipt: AttestationReceipt },
  cipher: ChatCipher = chatCipher(),
  now = Date.now(),
): Promise<ChatTurn> {
  return userTransaction(db, userId, async (tx) => {
    const sealedReply =
      outcome.state === "complete"
        ? cipher.seal(
            userId,
            input.conversationId,
            `${input.requestId}:assistant`,
            JSON.stringify(storedReplySchema.parse({ reply: outcome.reply, attestation: outcome.receipt })),
          )
        : null;
    const [row] = await tx
      .update(chatTurns)
      .set({ state: outcome.state, sealedReply })
      .where(
        and(
          eq(chatTurns.userId, userId),
          eq(chatTurns.conversationId, input.conversationId),
          eq(chatTurns.id, input.requestId),
          eq(chatTurns.leaseToken, token),
          eq(chatTurns.state, "pending"),
          gt(chatTurns.leaseExpiresAt, now),
        ),
      )
      .returning();
    if (!row) {
      throw new ChatError("conflict", "The reply was stopped or superseded. Reload the conversation.");
    }
    await touchConversation(tx, userId, input.conversationId, now);
    return displayTurn(row, cipher, now);
  });
}

export async function deleteConversation(
  db: AppDatabase,
  userId: string,
  conversationId: string,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const [deleted] = await tx
      .update(chatConversations)
      .set({ deletedAt: Date.now(), sealedTitle: null, revision: sql`${chatConversations.revision} + 1` })
      .where(
        and(
          eq(chatConversations.userId, userId),
          eq(chatConversations.id, conversationId),
          isNull(chatConversations.deletedAt),
        ),
      )
      .returning({ id: chatConversations.id });
    if (!deleted) {
      throw new ChatError("not_found", "Conversation not found.");
    }
    // Retain only the conversation ID tombstone: a delayed first send must not recreate deleted text.
    await tx
      .delete(chatTurns)
      .where(and(eq(chatTurns.userId, userId), eq(chatTurns.conversationId, conversationId)));
  });
}

/** Replaces a live conversation's title (the generated one after the first reply). Deleted chats stay deleted. */
export async function renameConversation(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  title: string,
  cipher: ChatCipher = chatCipher(),
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    await tx
      .update(chatConversations)
      .set({
        sealedTitle: cipher.seal(userId, conversationId, "title", title),
        revision: sql`${chatConversations.revision} + 1`,
      })
      .where(
        and(
          eq(chatConversations.userId, userId),
          eq(chatConversations.id, conversationId),
          isNull(chatConversations.deletedAt),
        ),
      );
  });
}
