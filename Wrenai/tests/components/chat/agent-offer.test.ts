import { describe, expect, it, vi } from "vitest";
import { latestAgentOffer } from "@/components/chat/agent-offer";
import type { ChatTurn } from "@/shared/chat";

vi.mock("@/server/chat/draft-actions", () => ({ createChatAgentSetup: vi.fn() }));
const turn: ChatTurn = {
  id: crypto.randomUUID(),
  sequence: 1,
  message: "Find an opportunity",
  includeContext: true,
  state: "complete",
  createdAt: 1000,
  reply: {
    content: "Wait for a confirmed edge.",
    receipt: {
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      completionId: "fixture",
      signatureKind: "provider_tee",
      verifiedAt: 1000,
      evidenceHash: "a".repeat(64),
    },
    context: null,
    historyTrimmed: false,
    research: [
      {
        tool: "arbitrage",
        status: "partial",
        summary: "No net edge confirmed",
        observedAt: 1000,
        items: [],
        sources: [],
        limitations: [],
      },
    ],
  },
};
describe("one agent suggestion per completed analysis", () => {
  it("offers the exact researched tool even if its execution is still a planning draft", () => {
    expect(latestAgentOffer("conversation", turn)).toMatchObject({ turnId: turn.id, tool: "arbitrage" });
    expect(latestAgentOffer("other", turn)?.key).not.toBe(latestAgentOffer("conversation", turn)?.key);
  });
  it("does not offer provisional, failed, stopped, unavailable or general replies", () => {
    for (const state of ["pending", "failed", "cancelled"] as const) {
      expect(latestAgentOffer("conversation", { ...turn, state })).toBeNull();
    }
    expect(latestAgentOffer("conversation", undefined)).toBeNull();
    expect(latestAgentOffer("conversation", { ...turn, reply: null })).toBeNull();
    if (!turn.reply) {
      throw new Error("Missing reply fixture");
    }
    expect(latestAgentOffer("conversation", { ...turn, reply: { ...turn.reply, research: [] } })).toBeNull();
    expect(
      latestAgentOffer("conversation", {
        ...turn,
        reply: {
          ...turn.reply,
          research: turn.reply.research?.map((report) => ({ ...report, status: "unavailable" })) ?? [],
        },
      }),
    ).toBeNull();
  });
  it("does not substitute another agent when the selected tool has no saved research", () => {
    expect(latestAgentOffer("conversation", { ...turn, tool: "perps" })).toBeNull();
  });
});
