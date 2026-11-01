import { type ChatEvent, chatEventSchema, chatResponseSchema } from "@/shared/chat";

/** Explicit rejection before streaming starts, so no optimistic pending row should survive. */
export class ChatRequestRejected extends Error {}

/** Incremental UTF-8/SSE framing; a dropped connection never promotes provisional text. */
export async function consumeChatStream(
  response: Response,
  receive: (event: ChatEvent) => void,
): Promise<void> {
  if (!response.ok) {
    const result = chatResponseSchema.parse(await response.json());
    if (!result.ok) {
      throw new ChatRequestRejected(result.message);
    }
    throw new Error("Unexpected chat response.");
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Chat streaming is unavailable. Try again.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 800_000) {
        throw new Error("The chat stream exceeded its limit.");
      }
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) {
          const event = chatEventSchema.parse(JSON.parse(data));
          if (event.type === "error") {
            if (!completed) {
              throw new Error(event.message);
            }
          } else if (!completed || event.type === "title") {
            receive(event);
          }
          if (event.type === "done") {
            completed = true;
          }
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (chunk.done) {
        ended = true;
        break;
      }
    }
    if (!completed) {
      throw new Error("The reply was interrupted before it was verified and saved.");
    }
  } catch (error) {
    // A network error in optional title metadata cannot invalidate a durably saved, verified answer.
    if (!completed) {
      throw error;
    }
  } finally {
    try {
      if (!ended) {
        // Cleanup must preserve the original transport error or already saved result.
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      reader.releaseLock();
    }
  }
}
