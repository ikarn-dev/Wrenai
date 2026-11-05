import { chatResult, chatUser } from "@/server/chat/access";
import { chatCipher } from "@/server/chat/cipher";
import { ChatError } from "@/server/chat/errors";
import { listConversations, readConversationPage } from "@/server/chat/queries";
import { chatResponseStream } from "@/server/chat/response-stream";
import { answerChat } from "@/server/chat/service";
import { database } from "@/server/db/client";
import { serverEnv } from "@/server/env";
import { type ChatFailureCode, chatInputSchema, chatPageInputSchema } from "@/shared/chat";
import { chatRoutingIssue } from "@/shared/chat-routing";

export const runtime = "nodejs";
export const maxDuration = 120;
const MAX_BODY_BYTES = 40_000;
const PRIVATE = { "Cache-Control": "private, no-store" };

function failureStatus(code: ChatFailureCode): number {
  switch (code) {
    case "signed_out":
      return 401;
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 503;
  }
}

export async function GET(request: Request): Promise<Response> {
  const result = await chatResult(async () => {
    const user = await chatUser("manage");
    const query = new URL(request.url).searchParams;
    if (!query.size) {
      return listConversations(database(), user.id);
    }
    const before = query.get("beforeSequence");
    const input = chatPageInputSchema.parse({
      conversationId: query.get("conversationId"),
      beforeSequence: before === null ? null : Number(before),
    });
    return readConversationPage(database(), user.id, input.conversationId, input.beforeSequence);
  });
  return Response.json(result, { status: result.ok ? 200 : failureStatus(result.code), headers: PRIVATE });
}

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
    const routingIssue = chatRoutingIssue(input.message, input.tool ?? null);
    if (routingIssue) {
      throw new ChatError("invalid_input", routingIssue);
    }
    const cipher = chatCipher();
    const stream = chatResponseStream(request.signal, async (signal, emit) => {
      const outcome = await chatResult(() => answerChat(database(), user, input, cipher, signal, emit));
      if (!outcome.ok) {
        emit({ type: "error", code: outcome.code, message: outcome.message });
      }
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
  return Response.json(result, { status: failureStatus(result.code), headers: PRIVATE });
}
