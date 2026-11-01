import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatTurn } from "@/shared/chat";
import { consumeChatStream } from "./stream";

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
});
