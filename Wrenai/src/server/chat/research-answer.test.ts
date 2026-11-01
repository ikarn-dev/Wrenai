import { beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceError } from "@/server/ai/verified-completion";
import { researchAnswer } from "./research-answer";

const cloud = vi.hoisted(() => ({ stream: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/verified-chat-stream", () => ({ verifiedChatStream: cloud.stream }));
vi.mock("@/server/research/dispatcher", () => ({ RESEARCH_DEFINITIONS: [], runResearchTool: cloud.read }));
const receipt = {
  model: "Qwen/Qwen3.8-27B",
  completionId: "test",
  signatureKind: "provider_tee",
  verifiedAt: 1000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: "{}",
} as const;
const call = {
  id: "call-1",
  type: "function",
  function: { name: "research_arbitrage", arguments: '{"symbols":["NEAR"]}' },
} as const;
const report = {
  tool: "arbitrage",
  status: "partial",
  summary: "No confirmed net edge",
  observedAt: 1000,
  items: [],
  sources: [],
  limitations: [],
} as const;
describe("verified read-only research rounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloud.read.mockResolvedValue(report);
  });
  it("executes read tools only after verified tool selection, then returns research with the final answer", async () => {
    cloud.stream
      .mockResolvedValueOnce({ content: "", calls: [call], receipt })
      .mockResolvedValueOnce({ content: "No qualified net edge was established.", calls: [], receipt });
    const events: unknown[] = [];
    const result = await researchAnswer(
      [{ role: "user", content: "Find arbitrage" }],
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.reports).toEqual([report]);
    expect(cloud.read).toHaveBeenCalledWith(
      call.function.name,
      call.function.arguments,
      expect.any(AbortSignal),
    );
    expect(cloud.stream.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: call.id,
    });
    expect(events).toContainEqual({ type: "reset" });
  });
  it("never dispatches a failed signature and caps repeated tool requests", async () => {
    cloud.stream.mockRejectedValueOnce(new InferenceError("verification_failed", "Rejected"));
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect(cloud.read).not.toHaveBeenCalled();
    cloud.stream.mockResolvedValue({ content: "", calls: [call], receipt });
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(cloud.read).toHaveBeenCalledTimes(2);
    expect(cloud.stream.mock.calls.at(-1)?.[0].allowTools).toBe(false);
  });
});
