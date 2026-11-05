"use server";

import { z } from "zod";
import { database } from "@/server/db/client";
import { type ChatResult, type ChatTurn, chatInputSchema } from "@/shared/chat";
import { chatResult, chatUser } from "./access";
import { claimChatTurn, deleteConversation } from "./turns";

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
