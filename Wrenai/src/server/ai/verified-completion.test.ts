import { ApiError } from "@nearai/inference-sdk/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn(), options: vi.fn(), keys: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({ nearAiKeys: cloud.keys }));
vi.mock("@nearai/inference-sdk/node", async (original) => ({
  ...(await original<typeof import("@nearai/inference-sdk/node")>()),
  InferenceClient: class {
    constructor(options: unknown) {
      cloud.options(options);
    }
    chat = { completions: { create: cloud.create } };
    verifyResponse = cloud.verify;
  },
}));

const request = { messages: [{ role: "user", content: "A public question" }], maxTokens: 4_000 } as const;
const chat = { ...request, verification: "chat_cached" } as const;

describe("verified inference transport and bounded chat evidence reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cloud.keys.mockReturnValue(["fixture-key-a", "fixture-key-b"]);
    let sequence = 0;
    cloud.create.mockImplementation(async () => ({
      id: `completion-${++sequence}`,
      choices: [{ finish_reason: "stop", message: { content: "A verified answer." } }],
    }));
    cloud.verify.mockImplementation(async (id: string) => ({
      id,
      signatureKind: "provider_tee",
      signature: { signedText: `deepseek-ai/DeepSeek-V4.1-Flash-1017:${"a".repeat(64)}:${"b".repeat(64)}` },
    }));
  });

  it("keeps strategy/default calls fresh, even on the same worker", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    await verifiedCompletion(request);
    await verifiedCompletion(request);
    expect(cloud.options).toHaveBeenCalledTimes(2);
    expect(cloud.options).toHaveBeenCalledWith(expect.objectContaining({ attestationCacheTimeToLiveMs: 0 }));
  });

  it("reuses only the chat deployment client, generates each answer and verifies each distinct response", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    const first = await verifiedCompletion(chat);
    const second = await verifiedCompletion(chat);
    expect(cloud.options).toHaveBeenCalledTimes(1);
    expect(cloud.options).toHaveBeenCalledWith(
      expect.objectContaining({
        attestationCacheTimeToLiveMs: 60_000,
        responseCacheTimeToLiveMs: 60_000,
        e2ee: true,
      }),
    );
    expect(cloud.create).toHaveBeenCalledTimes(2);
    expect(cloud.verify.mock.calls.map((call) => call[0])).toEqual([
      first.receipt.completionId,
      second.receipt.completionId,
    ]);
    expect(first.receipt.completionId).not.toBe(second.receipt.completionId);
  });

  it("requires a new deployment client when the 60-second cache bound expires", async () => {
    vi.useFakeTimers();
    try {
      const { verifiedCompletion } = await import("./verified-completion");
      await verifiedCompletion(chat);
      await vi.advanceTimersByTimeAsync(60_001);
      await verifiedCompletion(chat);
      expect(cloud.options).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates credentials and bounds the cache to five clients", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    for (const id of [1, 2, 3, 4, 5, 6, 1]) {
      cloud.keys.mockReturnValue([`fixture-key-${id}`]);
      await verifiedCompletion(chat);
    }
    expect(cloud.options).toHaveBeenCalledTimes(7);
  });

  it("recognizes Node SDK auth errors and rotates to the next configured key", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    cloud.create.mockRejectedValueOnce(
      new ApiError({
        code: "api.http_status",
        details: { resource: "model_metadata", status: 401 },
        retryable: false,
      }),
    );
    await verifiedCompletion(request);
    expect(cloud.options.mock.calls.map((call) => call[0]?.apiKey)).toEqual([
      "fixture-key-a",
      "fixture-key-b",
    ]);
  });

  it("falls back from DeepSeek to Qwen and verifies Qwen's exact model receipt", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    cloud.create.mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 429 });
    cloud.verify.mockImplementation(async (id: string) => ({
      id,
      signatureKind: "provider_tee",
      signature: { signedText: `Qwen/Qwen3.8-27B:${"a".repeat(64)}:${"b".repeat(64)}` },
    }));
    const result = await verifiedCompletion(request);
    expect(cloud.create.mock.calls.map((call) => call[0]?.model)).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "Qwen/Qwen3.8-27B",
    ]);
    expect(result.receipt.model).toBe("Qwen/Qwen3.8-27B");
    expect(cloud.verify).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel an HTTP 400 as a cryptographic verification failure or leak its body", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    cloud.create.mockRejectedValue({ status: 400, message: "private provider detail" });
    const result = verifiedCompletion(request);
    await expect(result).rejects.toMatchObject({ code: "unavailable" });
    await expect(result).rejects.not.toThrow("private provider detail");
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate an answer when its signature lookup service is unavailable", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    cloud.verify.mockRejectedValue(
      new ApiError({
        code: "api.http_status",
        details: { resource: "completion_signature", status: 503 },
        retryable: true,
      }),
    );
    await expect(verifiedCompletion(chat)).rejects.toMatchObject({ code: "unavailable" });
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an unverified follow-up even when deployment evidence was reused", async () => {
    const { verifiedCompletion } = await import("./verified-completion");
    await verifiedCompletion(chat);
    cloud.verify.mockResolvedValue({
      id: "completion-2",
      signatureKind: "gateway",
      signature: { signedText: "unverified" },
    });
    await expect(verifiedCompletion(chat)).rejects.toMatchObject({ code: "verification_failed" });
    expect(cloud.create).toHaveBeenCalledTimes(2);
  });
});
