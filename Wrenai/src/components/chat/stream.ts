import { type ChatEvent, chatEventSchema, chatResponseSchema } from "@/shared/chat";

/** Incremental UTF-8/SSE framing; a dropped connection never promotes provisional text. */
export async function consumeChatStream(
  response: Response,
  receive: (event: ChatEvent) => void,
): Promise<void> {
  if (!response.ok) {
    const result = chatResponseSchema.parse(await response.json());
    throw new Error(result.ok ? "Unexpected chat response." : result.message);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Chat streaming is unavailable. Try again.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 800_000) {
        throw new Error("The chat stream exceeded its limit.");
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          const event = chatEventSchema.parse(JSON.parse(frame.slice(6)));
          if (event.type === "error") {
            throw new Error(event.message);
          }
          receive(event);
          if (event.type === "done") {
            completed = true;
            return;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done) {
        break;
      }
    }
    if (!completed) {
      throw new Error("The reply was interrupted before it was verified and saved.");
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
