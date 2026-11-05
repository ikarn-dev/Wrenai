import { z } from "zod";
import {
  type ConversationPage,
  type ConversationSummary,
  chatFailureSchema,
  conversationPageSchema,
  conversationSummarySchema,
  MAX_CHAT_CONVERSATIONS,
} from "@/shared/chat";

async function readChat<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const raw: unknown = await fetch(path, { cache: "no-store", ...(signal ? { signal } : {}) })
    .then((response) => response.json())
    .catch((error: unknown) => {
      if (signal?.aborted) {
        throw error;
      }
      throw new Error("Chat data could not be loaded. Try again.");
    });
  const result = z
    .discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: schema }), chatFailureSchema])
    .safeParse(raw);
  if (!result.success) {
    throw new Error("Chat data could not be read. Try again.");
  }
  if (!result.data.ok) {
    throw new Error(result.data.message);
  }
  return result.data.value;
}

export function loadChatHistory(signal: AbortSignal): Promise<readonly ConversationSummary[]> {
  return readChat("/api/chat", z.array(conversationSummarySchema).max(MAX_CHAT_CONVERSATIONS), signal);
}

export function loadChatPage(
  id: string,
  beforeSequence: number | null = null,
  signal?: AbortSignal,
): Promise<ConversationPage> {
  const params = new URLSearchParams({ conversationId: id });
  if (beforeSequence !== null) {
    params.set("beforeSequence", String(beforeSequence));
  }
  return readChat(`/api/chat?${params}`, conversationPageSchema, signal);
}
