import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatResponseStream } from "@/server/chat/response-stream";

vi.mock("server-only", () => ({}));
const decoder = new TextDecoder();
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("live reply connection", () => {
  it("flushes an initial frame and heartbeats while work is pending, then clears its timer", async () => {
    const deferred: { resolve?: () => void } = {};
    const pending = new Promise<void>((resolve) => {
      deferred.resolve = resolve;
    });
    const reader = chatResponseStream(new AbortController().signal, () => pending).getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    expect(decoder.decode((await reader.read()).value)).toContain("Preparing reply");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decoder.decode((await reader.read()).value)).toBe(": keepalive\n\n");
    if (!deferred.resolve) {
      throw new Error("Work was not started");
    }
    deferred.resolve();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });
  it("aborts work and removes the heartbeat when the browser cancels", async () => {
    const aborted = vi.fn();
    const reader = chatResponseStream(
      new AbortController().signal,
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          );
        }),
    ).getReader();
    await reader.read();
    await reader.cancel();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });
});
