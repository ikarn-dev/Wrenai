import { chatResult, chatUser } from "@/server/chat/access";
import { chatCipher } from "@/server/chat/cipher";
import { ChatError } from "@/server/chat/errors";
import { answerChat } from "@/server/chat/service";
import { database } from "@/server/db/client";
import { serverEnv } from "@/server/env";
import { chatInputSchema } from "@/shared/chat";

export const runtime = "nodejs";
export const maxDuration = 120;
const MAX_BODY_BYTES = 40_000;

async function readInput(request: Request): Promise<unknown> {
  if (!request.body) {
    throw new ChatError("invalid_input", "Write a message first.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ChatError("invalid_input", "This message is too long. Shorten it and try again.");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ChatError("invalid_input", "The message could not be read. Try again.");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<Response> {
  const result = await chatResult(async () => {
    if (request.headers.get("origin") !== serverEnv().appOrigin) {
      throw new ChatError("invalid_input", "Open chat from Wrenai to send a message.");
    }
    const user = await chatUser("reply");
    const input = chatInputSchema.parse(await readInput(request));
    const cipher = chatCipher();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        const emit = (event: import("@/shared/chat").ChatEvent): void => {
          if (!closed) {
            output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        };
        try {
          const outcome = await chatResult(() => answerChat(database(), user, input, cipher, signal, emit));
          if (!outcome.ok) {
            emit({ type: "error", code: outcome.code, message: outcome.message });
          }
        } finally {
          if (!closed) {
            closed = true;
            output.close();
          }
        }
      },
      cancel() {
        closed = true;
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  });
  if (result.ok) {
    return result.value;
  }
  const status =
    result.code === "signed_out"
      ? 401
      : result.code === "invalid_input"
        ? 400
        : result.code === "not_found"
          ? 404
          : result.code === "conflict"
            ? 409
            : result.code === "rate_limited"
              ? 429
              : 503;
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
