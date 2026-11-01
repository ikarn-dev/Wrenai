import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeRateLimit } from "./rate-limit";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("request protection transport deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("aborts a stalled SDK HTTP request and fails closed", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://test.upstash.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
    const signals: AbortSignal[] = [];
    const transport = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("Missing request deadline."));
            return;
          }
          signals.push(signal);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", transport);
    expect(await consumeRateLimit("agents:owner", 4, 60_000)).toBe("unavailable");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  }, 6_000);
});
