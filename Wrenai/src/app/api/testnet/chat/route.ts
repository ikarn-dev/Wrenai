import { z } from "zod";
import { chatHistory, testnetChat } from "@/server/testnet/chat";
import { TestnetError } from "@/server/testnet/config";
import { removeTestnetConversation, testnetConversationList } from "@/server/testnet/conversations";
import { testnetDatabase } from "@/server/testnet/database";
import { protectTestnet, testnetBody, testnetFailure, testnetJson } from "@/server/testnet/http";
import { testnetOwner } from "@/server/testnet/session";
export const maxDuration = 180;
export async function GET(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, false);
    const db = testnetDatabase(),
      owner = await testnetOwner(db);
    if (!owner) {
      throw new TestnetError("unauthorized", "Start a testnet session.");
    }
    const query = new URL(request.url).searchParams;
    return testnetJson(
      query.get("view") === "list"
        ? await testnetConversationList(db, owner.id)
        : await chatHistory(db, owner.id, z.uuid().parse(query.get("conversationId") ?? owner.id)),
    );
  } catch (error) {
    return testnetFailure(error);
  }
}
export async function POST(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, true);
    const db = testnetDatabase(),
      owner = await testnetOwner(db);
    if (!owner) {
      throw new TestnetError("unauthorized", "Start a testnet session.");
    }
    await protectTestnet(request, true, owner.id);
    const input = z
      .object({
        conversationId: z.uuid().optional(),
        requestId: z.uuid(),
        message: z.string().trim().min(1).max(3000),
      })
      .parse(await testnetBody(request));
    const encoder = new TextEncoder(),
      cancel = new AbortController(),
      signal = AbortSignal.any([request.signal, cancel.signal]);
    let closed = false;
    return new Response(
      new ReadableStream({
        start(controller) {
          const emit = (event: unknown): void => {
            if (!closed && !signal.aborted) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          };
          controller.enqueue(encoder.encode(": connected\n\n"));
          const heartbeat = setInterval(() => {
            if (!closed && !signal.aborted) {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            }
          }, 15000);
          void testnetChat(
            db,
            owner,
            input.requestId,
            input.message,
            signal,
            emit,
            input.conversationId ?? owner.id,
          )
            .catch(() =>
              emit({ type: "error", message: "Reply incomplete. Your message is saved; try again." }),
            )
            .finally(() => {
              clearInterval(heartbeat);
              if (!closed) {
                closed = true;
                controller.close();
              }
            });
        },
        cancel() {
          closed = true;
          cancel.abort();
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch (error) {
    return testnetFailure(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, true);
    const db = testnetDatabase(),
      owner = await testnetOwner(db);
    if (!owner) {
      throw new TestnetError("unauthorized", "Start a testnet session.");
    }
    const { conversationId } = z.strictObject({ conversationId: z.uuid() }).parse(await testnetBody(request));
    await removeTestnetConversation(db, owner.id, conversationId);
    return testnetJson(null);
  } catch (error) {
    return testnetFailure(error);
  }
}
