import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAttestedStrategy } from "./strategy-parser";

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

const strategy = {
  kind: "rebalancer",
  targets: [
    { symbol: "NEAR", weightBps: 5000 },
    { symbol: "USDC", weightBps: 5000 },
  ],
  driftBps: 500,
  intervalSeconds: 300,
};
function completion(content: unknown = strategy, finishReason = "stop") {
  return {
    id: "completion-1",
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(content) } }],
  };
}
const verified = {
  id: "completion-1",
  signatureKind: "provider_tee",
  signature: {
    signedText: `deepseek-ai/DeepSeek-V4.1-Flash-1017:${"a".repeat(64)}:${"b".repeat(64)}`,
    signature: "verified-signature",
  },
  attestation: { testEvidence: "fixture" },
};

describe("attested strategy parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloud.keys.mockReturnValue(["test-credential-a", "test-credential-b"]);
    cloud.create.mockResolvedValue(completion());
    cloud.verify.mockResolvedValue(verified);
  });

  it("encrypts to the pinned model and verifies its exact response before returning a strategy", async () => {
    const result = await parseAttestedStrategy("rebalancer", "Keep equal allocations in NEAR and USDC.");
    expect(result.strategy).toEqual(strategy);
    expect(result.receipt.signatureKind).toBe("provider_tee");
    expect(result.receipt.requestHash).toBe("a".repeat(64));
    expect(result.receipt.responseHash).toBe("b".repeat(64));
    expect(result.receipt.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.receipt.evidenceJson)).toEqual(verified);
    expect(cloud.options).toHaveBeenCalledWith(
      expect.objectContaining({ e2ee: true, attestationCacheTimeToLiveMs: 0 }),
    );
    expect(cloud.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", stream: false }),
      expect.anything(),
    );
    expect(cloud.verify).toHaveBeenCalledWith("completion-1");
  });

  it("refuses gateway-only signatures even for otherwise valid strategy JSON", async () => {
    cloud.verify.mockResolvedValue({ ...verified, signatureKind: "gateway" });
    await expect(parseAttestedStrategy("rebalancer", "Equal NEAR and USDC")).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a response signature belonging to a different completion", async () => {
    cloud.verify.mockResolvedValue({ ...verified, id: "another-completion" });
    await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
      code: "verification_failed",
    });
  });

  it("rejects a missing or mismatched canonical model in a provider receipt", async () => {
    for (const prefix of [
      "",
      "different/model:",
      "Qwen/Qwen3.8-27B:",
      "deepseek/deepseek-v4.1-flash-1017:",
    ]) {
      cloud.verify.mockResolvedValue({
        ...verified,
        signature: { signedText: `${prefix}${"a".repeat(64)}:${"b".repeat(64)}` },
      });
      await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
        code: "verification_failed",
      });
    }
  });

  it("bounds a hung verification request without saving or moving to another model", async () => {
    vi.useFakeTimers();
    try {
      cloud.create.mockReturnValue(new Promise(() => {}));
      const result = expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
        code: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await result;
      expect(cloud.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on attestation failure without falling back or returning unverified data", async () => {
    cloud.verify.mockRejectedValue(new Error("bad quote"));
    await expect(parseAttestedStrategy("rebalancer", "Equal allocations")).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("rejects policy injection, unsupported tokens and wrong pack output", async () => {
    for (const content of [
      { ...strategy, approvalMode: "autonomous" },
      { ...strategy, targets: [{ symbol: "DOGE", weightBps: 10000 }] },
      { ...strategy, kind: "triggers" },
    ]) {
      cloud.create.mockResolvedValue(completion(content));
      await expect(parseAttestedStrategy("rebalancer", "An untrusted prompt")).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("surfaces verified clarification without saving an invented configuration", async () => {
    cloud.create.mockResolvedValue(completion({ error: "Which assets and target weights should I use?" }));
    await expect(parseAttestedStrategy("rebalancer", "Rebalance my wallet")).rejects.toThrow("Which assets");
    expect(cloud.verify).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated output and malformed JSON", async () => {
    cloud.create.mockResolvedValue(completion(strategy, "length"));
    await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
      code: "invalid_input",
    });
    cloud.create.mockResolvedValue({
      id: "completion-1",
      choices: [{ finish_reason: "stop", message: { content: "not JSON" } }],
    });
    await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rotates keys on auth/rate errors and uses the three attested models in the requested fallback order", async () => {
    cloud.create.mockRejectedValue({ status: 429 });
    await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toMatchObject({
      code: "unavailable",
    });
    const models = cloud.create.mock.calls.map((call) => call[0]?.model);
    expect(models).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "Qwen/Qwen3.8-27B",
      "Qwen/Qwen3.8-27B",
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ]);
  });

  it("never exposes missing credentials or provider error content", async () => {
    cloud.keys.mockImplementation(() => {
      throw new Error("sensitive provider error");
    });
    await expect(parseAttestedStrategy("rebalancer", "Strategy")).rejects.toThrow(
      "NEAR_AI_API_KEY is missing",
    );
    expect(cloud.create).not.toHaveBeenCalled();
  });
});
