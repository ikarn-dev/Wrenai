import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedChatStream } from "./verified-chat-stream";
import { InferenceError } from "./verified-completion";

const cloud = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({ nearAiKeys: () => ["test-key"] }));
vi.mock("./inference-client", () => ({
  inferenceClient: () => ({ chat: { completions: { create: cloud.create } } }),
}));
vi.mock("./verified-completion", async (original) => ({
  ...(await original<typeof import("./verified-completion")>()),
  verifyInferenceReceipt: cloud.verify,
}));
const receipt = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  completionId: "test",
  signatureKind: "provider_tee",
  verifiedAt: 1000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: "{}",
} as const;
function stream(deltas: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield delta;
      }
    },
  };
}
function chunk(delta: unknown, finish_reason: string | null = null): unknown {
  return { id: "test", choices: [{ delta, finish_reason }] };
}
const request = {
  messages: [{ role: "user", content: "Find current markets" }],
  tools: [],
  signal: new AbortController().signal,
  allowTools: true,
  onDelta: () => {},
} as const;
describe("verified streaming provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloud.verify.mockResolvedValue(receipt);
  });
  it("assembles real provider nullable function chunks before verifying", async () => {
    cloud.create.mockResolvedValue(
      stream([
        chunk({ content: "\n\n", tool_calls: null }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "research_arbitrage", arguments: "" },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: null,
              type: "function",
              function: { name: null, arguments: '{"symbols":["NEAR"]}' },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ]),
    );
    const result = await verifiedChatStream(request);
    expect(result.calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "research_arbitrage", arguments: '{"symbols":["NEAR"]}' },
      },
    ]);
    expect(result.receipt).toEqual(receipt);
  });
  it("uses DeepSeek, then Qwen, then GLM when each earlier model is unavailable before streaming", async () => {
    cloud.create
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue(stream([chunk({ content: "A verified fallback answer" }), chunk({}, "stop")]));
    cloud.verify.mockResolvedValue({ ...receipt, model: "z-ai/glm-5.3-flash" });
    const result = await verifiedChatStream(request);
    expect(cloud.create.mock.calls.map((call) => call[0]?.model)).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "Qwen/Qwen3.8-27B",
      "z-ai/glm-5.3-flash",
    ]);
    expect(result.receipt.model).toBe("z-ai/glm-5.3-flash");
    expect(cloud.verify).toHaveBeenCalledTimes(1);
  });

  it("emits genuine chunks provisionally but refuses failed signatures and partial output", async () => {
    const seen: string[] = [];
    cloud.create.mockResolvedValue(stream([chunk({ content: "Provisional" }), chunk({}, "stop")]));
    cloud.verify.mockRejectedValueOnce(new InferenceError("verification_failed", "Rejected"));
    await expect(
      verifiedChatStream({ ...request, onDelta: (text) => seen.push(text) }),
    ).rejects.toMatchObject({ code: "verification_failed" });
    expect(seen).toEqual(["Provisional"]);
    expect(cloud.create).toHaveBeenCalledTimes(1);
    cloud.create.mockResolvedValue(stream([chunk({ content: "Partial" }), chunk({}, "length")]));
    await expect(verifiedChatStream(request)).rejects.toMatchObject({ code: "invalid_input" });
    expect(cloud.verify).toHaveBeenCalledTimes(1);
  });
});
