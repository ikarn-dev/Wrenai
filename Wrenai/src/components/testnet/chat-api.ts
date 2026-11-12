"use client";
import { z } from "zod";
import { conversationSummarySchema } from "@/shared/chat";
export const testnetChatMessageSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  createdAt: z.number(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  orderId: z.string().nullable(),
});
export type TestnetChatMessage = z.infer<typeof testnetChatMessageSchema>;
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("status"), message: z.string() }),
  z.object({
    type: z.literal("done"),
    text: z.string(),
    orderId: z.string().nullable(),
    verified: z.boolean().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
async function read<T extends z.ZodType>(
  url: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.output<T>> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const raw: unknown = await response.json();
  const failed = z.object({ ok: z.literal(false), message: z.string() }).safeParse(raw);
  if (failed.success) {
    throw new Error(failed.data.message);
  }
  const envelope = z.object({ ok: z.literal(true), data: z.unknown() }).parse(raw);
  return schema.parse(envelope.data);
}
export function loadTestnetChats(signal: AbortSignal) {
  return read("/api/testnet/chat?view=list", z.array(conversationSummarySchema.omit({ revision: true })), {
    signal,
  });
}
export function loadTestnetMessages(id: string, signal: AbortSignal) {
  return read(
    `/api/testnet/chat?conversationId=${encodeURIComponent(id)}`,
    z.array(testnetChatMessageSchema),
    { signal },
  );
}
export async function deleteTestnetChat(
  id: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await read("/api/testnet/chat", z.null(), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: "unavailable",
      message: e instanceof Error ? e.message : "Deletion could not be confirmed.",
    };
  }
}
export async function streamTestnetChat(
  input: { conversationId: string; requestId: string; message: string },
  signal: AbortSignal,
  emit: (value: z.infer<typeof event>) => void,
): Promise<void> {
  const response = await fetch("/api/testnet/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("Chat could not be started. Refresh and try again.");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 100000) {
        throw new Error("The chat stream exceeded its limit.");
      }
      let end = pending.indexOf("\n\n");
      while (end >= 0) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const line = block.split("\n").find((line) => line.startsWith("data: "));
        if (line) {
          const data = event.parse(JSON.parse(line.slice(6)));
          if (data.type === "error") {
            throw new Error(data.message);
          }
          if (data.type === "done") {
            done = true;
          }
          emit(data);
        }
        end = pending.indexOf("\n\n");
      }
    }
    if (!done) {
      throw new Error("Reply interrupted. Check saved history before retrying.");
    }
  } finally {
    reader.releaseLock();
  }
}
