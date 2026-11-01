import "server-only";
import type { ChatEvent } from "@/shared/chat";
import { chatStatus } from "@/shared/chat-status";

const HEARTBEAT_MS = 10_000;

/** Activity frames keep proxies from treating model/research waits as a dead stream. Timers are request-local. */
export function chatResponseStream(
  requestSignal: AbortSignal,
  run: (signal: AbortSignal, emit: (event: ChatEvent) => void) => Promise<void>,
): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = (): void => {
    clearInterval(heartbeat);
  };
  return new ReadableStream<Uint8Array>({
    async start(output) {
      const write = (frame: string): void => {
        if (!closed) {
          output.enqueue(encoder.encode(frame));
        }
      };
      const emit = (event: ChatEvent): void => write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        signal.throwIfAborted();
        write(": connected\n\n");
        emit({ type: "status", message: chatStatus("preparing") });
        heartbeat = setInterval(() => write(": keepalive\n\n"), HEARTBEAT_MS);
        signal.addEventListener("abort", stopHeartbeat, { once: true });
        await run(signal, emit);
      } finally {
        stopHeartbeat();
        signal.removeEventListener("abort", stopHeartbeat);
        if (!closed) {
          closed = true;
          output.close();
        }
      }
    },
    cancel() {
      closed = true;
      stopHeartbeat();
      controller.abort();
    },
  });
}
