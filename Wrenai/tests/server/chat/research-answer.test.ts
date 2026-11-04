import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InferenceError } from "@/server/ai/verified-completion";
import { chatPrompt } from "@/server/chat/prompt";
import { researchAnswer } from "@/server/chat/research-answer";
import { activeAgentToolSchema } from "@/shared/agent-scope";

const cloud = vi.hoisted(() => ({ stream: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/verified-chat-stream", () => ({ verifiedChatStream: cloud.stream }));
vi.mock("@/server/research/dispatcher", async () => {
  const { activeAgentToolSchema } = await import("@/shared/agent-scope");
  return {
    RESEARCH_DEFINITIONS: activeAgentToolSchema.options.map((tool) => ({
      type: "function",
      function: {
        name: `research_${tool}`,
        description: "Read-only test tool",
        parameters: { type: "object" },
      },
    })),
    runResearchTool: cloud.read,
  };
});
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
  function: { name: "research_perps", arguments: '{"symbols":["NEAR"]}' },
} as const;
const report = {
  tool: "perps",
  status: "partial",
  summary: "No confirmed net edge",
  observedAt: 1000,
  items: [
    {
      id: "checked",
      title: "Checked spread",
      kind: "opportunity",
      status: "no_edge",
      metrics: [],
      note: "No confirmed edge",
      sourceIds: [],
    },
  ],
  sources: [],
  limitations: [],
} as const;
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable() })),
});
describe("verified read-only research rounds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cloud.read.mockResolvedValue(report);
  });
  it("executes read tools only after verified tool selection, then returns research with the final answer", async () => {
    cloud.stream
      .mockResolvedValueOnce({ content: "", calls: [call], receipt })
      .mockResolvedValueOnce({ content: "No qualified net edge was established.", calls: [], receipt });
    const events: unknown[] = [];
    const result = await researchAnswer(
      [{ role: "user", content: "Find perps" }],
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
    expect(cloud.read).toHaveBeenCalledTimes(1);
    expect(cloud.stream.mock.calls.at(-1)?.[0].allowTools).toBe(false);
  });

  it("exposes only the selected tool and rejects a different tool before dispatch", async () => {
    cloud.stream.mockResolvedValueOnce({
      content: "",
      calls: [{ ...call, function: { ...call.function, name: "research_meme_hunter" } }],
      receipt,
    });
    await expect(researchAnswer([], new AbortController().signal, () => {}, "perps")).rejects.toMatchObject({
      code: "invalid_input",
    });
    const request = z
      .object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })) })
      .parse(cloud.stream.mock.calls[0]?.[0]);
    expect(request.tools.map((tool) => tool.function.name)).toEqual(["research_perps"]);
    expect(cloud.read).not.toHaveBeenCalled();
  });

  it("rejects a mismatched selected tool before any inference or market reads", async () => {
    await expect(
      researchAnswer(
        [{ role: "user", content: "Compare current NEAR yield opportunities" }],
        new AbortController().signal,
        () => {},
        "dca",
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(cloud.stream).not.toHaveBeenCalled();
    expect(cloud.read).not.toHaveBeenCalled();
  });

  it("validates the entire batch before dispatching even a valid companion call", async () => {
    cloud.stream.mockResolvedValueOnce({
      content: "",
      calls: [
        call,
        { ...call, id: "bad", function: { name: "research_dca", arguments: '{"symbols":["NEAR"]}' } },
      ],
      receipt,
    });
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(cloud.read).not.toHaveBeenCalled();
    expect(cloud.stream).toHaveBeenCalledTimes(1);
  });

  it("deduplicates equivalent parallel calls while retaining each tool response ID", async () => {
    cloud.stream
      .mockResolvedValueOnce({
        content: "",
        calls: [
          call,
          {
            ...call,
            id: "same-input",
            function: { ...call.function, arguments: '{ "symbols" : ["NEAR"] }' },
          },
        ],
        receipt,
      })
      .mockResolvedValueOnce({ content: "Wait for a confirmed edge", calls: [], receipt });
    const result = await researchAnswer([], new AbortController().signal, () => {});
    expect(cloud.read).toHaveBeenCalledTimes(1);
    expect(result.reports).toHaveLength(1);
    const next = requestSchema.parse(cloud.stream.mock.calls[1]?.[0]);
    expect(next.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("stops after unavailable data instead of spending another inference on filler", async () => {
    cloud.read.mockResolvedValueOnce({ ...report, status: "unavailable", items: [] });
    cloud.stream.mockResolvedValueOnce({ content: "", calls: [call], receipt });
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(cloud.stream).toHaveBeenCalledTimes(1);
  });
  it("surfaces an ambiguous token contract without another inference or fabricated recommendation", async () => {
    cloud.read.mockResolvedValueOnce({
      ...report,
      tool: "meme_hunter",
      status: "unavailable",
      items: [],
      assessment: {
        decision: "needs_input",
        summary: "Several contracts use that ticker. Specify the exact token contract.",
        reasons: [],
        conditions: [],
        sourceIds: [],
      },
    });
    cloud.stream.mockResolvedValueOnce({
      content: "",
      calls: [{ ...call, function: { name: "research_meme_hunter", arguments: '{"symbols":["SAME"]}' } }],
      receipt,
    });
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("exact token"),
    });
    expect(cloud.stream).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate tool-call IDs before fetching anything", async () => {
    cloud.stream.mockResolvedValueOnce({ content: "", calls: [call, call], receipt });
    await expect(researchAnswer([], new AbortController().signal, () => {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(cloud.read).not.toHaveBeenCalled();
  });

  it("does not save a claimed live answer with no fresh research", async () => {
    cloud.stream.mockResolvedValueOnce({ content: "Invented current yield", calls: [], receipt });
    await expect(
      researchAnswer(
        [{ role: "user", content: "Compare current NEAR perps" }],
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(cloud.read).not.toHaveBeenCalled();
  });

  it("allows a concise missing-market question without fetching or forcing a side", async () => {
    cloud.stream.mockResolvedValueOnce({
      content: "Which perpetual market should I analyze?",
      calls: [],
      receipt,
    });
    const result = await researchAnswer(
      [{ role: "user", content: "Should I go long now?" }],
      new AbortController().signal,
      () => {},
      "perps",
    );
    expect(result.content).toBe("Which perpetual market should I analyze?");
    expect(result.reports).toEqual([]);
    expect(cloud.read).not.toHaveBeenCalled();
  });

  it.each(activeAgentToolSchema.options)(
    "keeps the shared reply policy throughout %s research",
    async (tool) => {
      const selection = {
        ...call,
        function: {
          name: `research_${tool}`,
          arguments: JSON.stringify({
            symbols: ["dca", "spot_trader", "buy_the_dip", "sell_the_top"].includes(tool)
              ? ["NEAR", "USDC"]
              : ["NEAR"],
            ...(tool === "private_payments" ? { accountId: "owner.near" } : {}),
          }),
        },
      };
      const evidence = {
        ...report,
        tool,
        sources: [
          {
            id: "public-source",
            label: "Public evidence",
            url: "https://example.org/market",
            observedAt: 1000,
          },
        ],
      };
      cloud.read.mockResolvedValueOnce(evidence);
      cloud.stream
        .mockResolvedValueOnce({ content: "", calls: [selection], receipt })
        .mockResolvedValueOnce({ content: "Wait for a confirmed opportunity.", calls: [], receipt });
      const prompt = chatPrompt([], "Research this market", null, 1000, tool);
      await researchAnswer(prompt.messages, new AbortController().signal, () => {}, tool);
      const rounds = cloud.stream.mock.calls.map(([request]) => requestSchema.parse(request));
      for (const round of rounds) {
        const instruction = round.messages.find((message) => message.role === "system")?.content;
        expect(instruction).toBe(prompt.messages[0]?.content);
        expect(instruction).toContain("Do not add Source/Sources sections");
        expect(instruction).toContain("Keep venue, protocol, pool and token names");
        expect(instruction).not.toContain("Cite the tool's actual source URLs and timestamps");
      }
      const toolMessage = rounds.at(-1)?.messages.at(-1);
      expect(toolMessage?.role).toBe("tool");
      expect(JSON.parse(toolMessage?.content ?? "null")).toEqual(evidence);
    },
  );
});
