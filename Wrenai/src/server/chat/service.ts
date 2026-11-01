import "server-only";
import { z } from "zod";
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
import { type ChatCipher, chatCipher } from "./cipher";
import { readChatContext } from "./context";
import { ChatError } from "./errors";
import { chatPrompt } from "./prompt";
import { conversationHistory } from "./queries";
import { readChatCache, writeChatCache } from "./redis-cache";
import { researchAnswer } from "./research-answer";
import { claimChatTurn, finishChatTurn } from "./turns";

export async function answerChat(
  db: AppDatabase,
  user: SessionUser,
  input: ChatInput,
  cipher: ChatCipher = chatCipher(),
  signal?: AbortSignal,
  emit: (event: ChatEvent) => void = () => {},
): Promise<ChatTurn> {
  const claim = await claimChatTurn(db, user.id, input, { cipher });
  if (claim.kind === "cached") {
    emit({ type: "done", turn: claim.turn });
    return claim.turn;
  }
  emit({ type: "turn", turn: claim.turn });
  const deadline = AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  try {
    const stamp = claim.historyTip ? `context:${claim.historyTip}` : null;
    const cached = stamp
      ? await readChatCache(user.id, input.conversationId, stamp, z.array(chatTurnSchema).max(25), cipher)
      : null;
    const [context, history] = await Promise.all([
      input.includeContext ? readChatContext(db, user) : Promise.resolve(null),
      claim.turn.sequence === 1
        ? Promise.resolve([])
        : (cached ?? conversationHistory(db, user.id, input.conversationId, claim.turn.sequence, cipher)),
    ]);
    const prompt = chatPrompt(history, input.message, context, Date.now());
    const completion = await researchAnswer(prompt.messages, deadline, emit);
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
    const saved = await finishChatTurn(
      db,
      user.id,
      input,
      claim.token,
      { state: "complete", reply, receipt: completion.receipt },
      cipher,
    );
    emit({ type: "done", turn: saved });
    await writeChatCache(
      user.id,
      input.conversationId,
      `context:${saved.id}`,
      [...history, saved].slice(-25),
      cipher,
    );
    return saved;
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
}
