"use server";

import { z } from "zod";
import { database } from "@/server/db/client";
import {
  type ChatResult,
  type ChatTurn,
  type ConversationPage,
  type ConversationSummary,
  chatInputSchema,
  chatPageInputSchema,
} from "@/shared/chat";
import { chatResult, chatUser } from "./access";
import { listConversations, readConversationPage } from "./queries";
import { claimChatTurn, deleteConversation } from "./turns";

export async function loadChatHistory(): Promise<ChatResult<readonly ConversationSummary[]>> {
  return chatResult(async () => listConversations(database(), (await chatUser("manage")).id));
}

export async function loadChatPage(raw: unknown): Promise<ChatResult<ConversationPage>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const input = chatPageInputSchema.parse(raw);
    return readConversationPage(database(), user.id, input.conversationId, input.beforeSequence);
  });
}

export async function removeConversation(raw: unknown): Promise<ChatResult<null>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    await deleteConversation(database(), user.id, z.uuid().parse(raw));
    return null;
  });
}

export async function stopChatReply(raw: unknown): Promise<ChatResult<ChatTurn>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const claim = await claimChatTurn(database(), user.id, chatInputSchema.parse(raw), { cancel: true });
    return claim.turn;
  });
}
