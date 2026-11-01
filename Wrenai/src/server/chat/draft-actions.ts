"use server";
import { z } from "zod";
import { database } from "@/server/db/client";
import type { ChatResult } from "@/shared/chat";
import { type AgentSetupDraft, researchToolSchema } from "@/shared/research";
import { chatResult, chatUser } from "./access";
import { createAgentSetup, createManualAgentSetup, deleteAgentSetup, updateAgentSetup } from "./agent-drafts";
import { chatCipher } from "./cipher";

export async function createChatAgentSetup(raw: unknown): Promise<ChatResult<AgentSetupDraft>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const input = z
      .strictObject({ conversationId: z.uuid(), turnId: z.uuid(), tool: researchToolSchema })
      .parse(raw);
    return createAgentSetup(database(), user.id, input.conversationId, input.turnId, input.tool);
  });
}
export async function saveChatAgentSetup(raw: unknown): Promise<ChatResult<null>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const input = z
      .strictObject({
        id: z.uuid(),
        brief: z.string().trim().min(1).max(4000).nullable(),
        reviewed: z.boolean().optional(),
      })
      .parse(raw);
    return updateAgentSetup(
      database(),
      user.id,
      input.id,
      input.brief,
      chatCipher(),
      input.reviewed ?? false,
    );
  });
}

export async function createAgentToolSetup(raw: unknown): Promise<ChatResult<AgentSetupDraft>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const input = z
      .strictObject({
        id: z.uuid(),
        tool: researchToolSchema,
        answers: z.array(z.string().trim().min(1).max(900)).length(3),
        notes: z.string().trim().max(600),
      })
      .parse(raw);
    return createManualAgentSetup(database(), user.id, input.id, input.tool, input.answers, input.notes);
  });
}

export async function removeAgentSetup(raw: unknown): Promise<ChatResult<null>> {
  return chatResult(async () => {
    const user = await chatUser("manage");
    const input = z.strictObject({ id: z.uuid() }).parse(raw);
    return deleteAgentSetup(database(), user.id, input.id);
  });
}
