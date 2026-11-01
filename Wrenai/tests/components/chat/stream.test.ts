import { describe, expect, it, vi } from "vitest";
import { ChatRequestRejected, consumeChatStream } from "@/components/chat/stream";
import type { ChatEvent, ChatTurn } from "@/shared/chat";

const turn: ChatTurn = {
  id: crypto.randomUUID(),
  sequence: 1,
  message: "Hello",
  includeContext: false,
  state: "cancelled",
  reply: null,
  createdAt: 1000,
};
function response(events: readonly ChatEvent[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  let cursor = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(cursor, cursor + 1));
        cursor++;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
describe("incremental chat transport", () => {
  it("distinguishes a rejected request from an unknown network outcome", async () => {
    await expect(
      consumeChatStream(
        Response.json({ ok: false, code: "rate_limited", message: "Wait before retrying." }, { status: 429 }),
        () => {},
      ),
    ).rejects.toBeInstanceOf(ChatRequestRejected);
    await expect(
      consumeChatStream(new Response("Gateway unavailable", { status: 503 }), () => {}),
    ).rejects.not.toBeInstanceOf(ChatRequestRejected);
  });
  it("delivers split UTF-8 deltas before a durable done event", async () => {
    const seen: ChatEvent[] = [];
    await consumeChatStream(
      response([{ type: "delta", text: "NEAR → USDC" }, { type: "verified" }, { type: "done", turn }]),
      (event) => seen.push(event),
    );
    expect(seen).toEqual([
      { type: "delta", text: "NEAR → USDC" },
      { type: "verified" },
      { type: "done", turn },
    ]);
  });
  it("rejects incomplete or failed streams instead of accepting provisional content", async () => {
    await expect(
      consumeChatStream(response([{ type: "delta", text: "Unverified" }]), () => {}),
    ).rejects.toThrow("interrupted");
    await expect(
      consumeChatStream(
        response([
          { type: "delta", text: "Unverified" },
          { type: "error", code: "verification_failed", message: "Verification failed." },
        ]),
        () => {},
      ),
    ).rejects.toThrow("Verification failed");
  });

  it("preserves the verification error even if cancelling the reader also fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"error","code":"verification_failed","message":"Verification failed."}\n\n',
          ),
        );
      },
      cancel() {
        throw new Error("Cleanup failed");
      },
    });
    await expect(
      consumeChatStream(new Response(stream, { headers: { "content-type": "text/event-stream" } }), () => {}),
    ).rejects.toThrow("Verification failed");
  });

  it("delivers completion immediately without cancelling delayed title metadata", async () => {
    const encoder = new TextEncoder();
    const source: { controller?: ReadableStreamDefaultController<Uint8Array> } = {};
    const cancel = vi.fn();
    const seen: ChatEvent[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source.controller = controller;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", turn })}\n\n`));
      },
      cancel,
    });
    const pending = consumeChatStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      (event) => seen.push(event),
    );
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "done", turn }));
    expect(cancel).not.toHaveBeenCalled();
    if (!source.controller) {
      throw new Error("Stream did not start");
    }
    source.controller.enqueue(encoder.encode('data: {"type":"title","title":"Market research"}\n\n'));
    source.controller.close();
    await pending;
    expect(seen.at(-1)).toEqual({ type: "title", title: "Market research" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("accepts heartbeat comments, CRLF framing and multi-line data without inventing reply text", async () => {
    const saved = JSON.stringify({ type: "done", turn }, null, 2)
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\r\n");
    const bytes = new TextEncoder().encode(`: connected\r\n\r\n: keepalive\r\n\r\n${saved}\r\n\r\n`);
    let cursor = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor === bytes.length) {
          controller.close();
        } else {
          controller.enqueue(bytes.slice(cursor, ++cursor));
        }
      },
    });
    const seen: ChatEvent[] = [];
    await consumeChatStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      (event) => seen.push(event),
    );
    expect(seen).toEqual([{ type: "done", turn }]);
  });

  it("keeps a durable result when the optional metadata connection fails later", async () => {
    const source: { controller?: ReadableStreamDefaultController<Uint8Array> } = {};
    const seen: ChatEvent[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source.controller = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", turn })}\n\n`));
      },
    });
    const pending = consumeChatStream(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      (event) => seen.push(event),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    if (!source.controller) {
      throw new Error("Stream did not start");
    }
    source.controller.error(new Error("Connection reset after saving"));
    await expect(pending).resolves.toBeUndefined();
    expect(seen).toEqual([{ type: "done", turn }]);
  });
});
