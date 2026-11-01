import "server-only";
import { z } from "zod";
import { prepareChatInference } from "@/server/ai/chat-preparation";
import { InferenceError } from "@/server/ai/verified-completion";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import {
  type ChatEvent,
  type ChatInput,
  type ChatTurn,
  chatReplySchema,
  chatTurnSchema,
} from "@/shared/chat";
import { chatRoutingIssue } from "@/shared/chat-routing";
import { chatStatus } from "@/shared/chat-status";
import { type ChatCipher, chatCipher } from "./cipher";
import { readChatContext } from "./context";
import { ChatError } from "./errors";
import { chatPrompt } from "./prompt";
import { conversationHistory } from "./queries";
import { readChatCache, writeChatCache } from "./redis-cache";
import { researchAnswer } from "./research-answer";
import { generateChatTitle } from "./title";
import { claimChatTurn, finishChatTurn, renameConversation } from "./turns";

/**
 * Names a new chat after its first reply. The reply is already saved and shown, so a title failure changes
 * nothing for the user: the first message, saved as the title when the chat began, stays.
 */
async function titleConversation(
  db: AppDatabase,
  userId: string,
  input: ChatInput,
  reply: string,
  cipher: ChatCipher,
  signal: AbortSignal | undefined,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  const title = await generateChatTitle(input.message, reply, signal).catch((error: unknown) => {
    if (error instanceof InferenceError) {
      return null;
    }
    throw error;
  });
  if (title === null) {
    return;
  }
  await renameConversation(db, userId, input.conversationId, title, cipher);
  emit({ type: "title", title });
}

export async function answerChat(
  db: AppDatabase,
  user: SessionUser,
  input: ChatInput,
  cipher: ChatCipher = chatCipher(),
  signal?: AbortSignal,
  emit: (event: ChatEvent) => void = () => {},
): Promise<ChatTurn> {
  const routingIssue = chatRoutingIssue(input.message, input.tool ?? null);
  if (routingIssue) {
    throw new ChatError("invalid_input", routingIssue);
  }
  const claim = await claimChatTurn(db, user.id, input, { cipher });
  if (claim.kind === "cached") {
    emit({ type: "done", turn: claim.turn });
    return claim.turn;
  }
  emit({ type: "turn", turn: claim.turn });
  emit({ type: "status", message: chatStatus("preparing") });
  const deadline = AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  let saved: ChatTurn;
  let history: readonly ChatTurn[] = [];
  try {
    const historyRead = async (): Promise<readonly ChatTurn[]> => {
      if (claim.turn.sequence === 1) {
        return [];
      }
      const cached = claim.historyTip
        ? await readChatCache(
            user.id,
            input.conversationId,
            `context:${claim.historyTip}`,
            z.array(chatTurnSchema).max(25),
            cipher,
          )
        : null;
      return cached ?? conversationHistory(db, user.id, input.conversationId, claim.turn.sequence, cipher);
    };
    const [context, previous] = await Promise.all([
      input.includeContext ? readChatContext(db, user) : Promise.resolve(null),
      historyRead(),
      prepareChatInference(deadline),
    ]);
    history = previous;
    const prompt = chatPrompt(history, input.message, context, Date.now(), input.tool ?? null);
    const completion = await researchAnswer(prompt.messages, deadline, emit, input.tool ?? null);
    deadline.throwIfAborted();
    emit({ type: "verified" });
    const { model, completionId, signatureKind, verifiedAt, evidenceHash } = completion.receipt;
    const reply = chatReplySchema.parse({
      content: completion.content,
      receipt: { model, completionId, signatureKind, verifiedAt, evidenceHash },
      context,
      historyTrimmed: prompt.historyTrimmed,
      research: completion.reports,
    });
    saved = await finishChatTurn(
      db,
      user.id,
      input,
      claim.token,
      { state: "complete", reply, receipt: completion.receipt },
      cipher,
    );
  } catch (error) {
    if (error instanceof ChatError && error.code === "conflict") {
      throw error;
    }
    await finishChatTurn(db, user.id, input, claim.token, { state: "failed" }, cipher);
    if (error instanceof InferenceError) {
      throw new ChatError(error.code, error.message);
    }
    throw new ChatError("unavailable", "The reply could not be completed. Your message is saved; try again.");
  }
  // Saving is the terminal answer boundary. Optional metadata must never downgrade an already saved reply.
  emit({ type: "done", turn: saved });
  const extras = await Promise.allSettled([
    claim.turn.sequence === 1 && !signal?.aborted && saved.reply
      ? titleConversation(db, user.id, input, saved.reply.content, cipher, signal, emit)
      : Promise.resolve(),
    writeChatCache(
      user.id,
      input.conversationId,
      `context:${saved.id}`,
      [...history, saved].slice(-25),
      cipher,
    ),
  ]);
  if (extras.some((result) => result.status === "rejected")) {
    process.emitWarning("A saved chat reply's optional title or cache update could not finish.", {
      code: "WRENAI_CHAT_METADATA",
    });
  }
  return saved;
}
