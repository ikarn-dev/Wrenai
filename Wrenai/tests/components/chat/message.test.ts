import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatMessage } from "@/components/chat/message";
import type { ChatTurn } from "@/shared/chat";

vi.mock("@/server/chat/draft-actions", () => ({ createChatAgentSetup: vi.fn() }));
vi.mock("@/server/manual-trading/actions", () => ({
  readManualOrder: vi.fn(),
  confirmManualOrder: vi.fn(),
  dismissManualOrder: vi.fn(),
  requestManualQuote: vi.fn(),
}));
vi.mock("@/components/trading/trade-card", () => ({
  TradeCard: ({ id }: { readonly id: string }) =>
    createElement("section", { "aria-label": "Trade confirmation", "data-trade-id": id }, "Confirm trade"),
}));

vi.mock("@/components/trading/quote-request", () => ({
  QuoteRequest: () => createElement("section", { "aria-label": "Trade quote" }, "Getting a live quote…"),
}));

const content =
  "## Current view\n\nWait for confirmation.\n\n| Market | View |\n| --- | --- |\n| BTC | Wait |\n\n```text\nNo order submitted.\n```";
const pendingTurn: ChatTurn = {
  id: "94f37cdd-e41b-4a10-8a42-9ea76e427a55",
  sequence: 1,
  message: "Should I go long or short BTC?",
  includeContext: true,
  state: "pending",
  reply: null,
  createdAt: 1,
};
const completeTurn: ChatTurn = {
  ...pendingTurn,
  state: "complete",
  reply: {
    content,
    receipt: {
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      completionId: "fixture-completion",
      signatureKind: "provider_tee",
      verifiedAt: 1,
      evidenceHash: "a".repeat(64),
    },
    context: null,
    historyTrimmed: false,
  },
};

function render(turn: ChatTurn, streaming: boolean, previewContent = content): string {
  return renderToStaticMarkup(
    createElement(ChatMessage, {
      turn,
      last: true,
      busy: streaming,
      onRetry: vi.fn(),
      pendingReply: streaming
        ? { content: previewContent, status: "Verification pending", checking: false, onCheck: null }
        : null,
    }),
  );
}

describe("streamed reply layout", () => {
  it("renders a pending quote beneath its saved reply without a false model verification label", () => {
    if (!completeTurn.reply) {
      throw new Error("Missing reply");
    }
    const html = render(
      {
        ...completeTurn,
        reply: {
          ...completeTurn.reply,
          content: "Review your quote below.",
          receipt: null,
          manual: {
            text: "Review your quote below.",
            tradeIds: [],
            quoteRequest: {
              requestId: crypto.randomUUID(),
              inputToken: "NEAR",
              outputToken: "USDC",
              amount: "0.1",
            },
          },
        },
      },
      false,
    );
    expect(html).toContain("Getting a live quote…");
    expect(html).not.toContain("Model response verified");
    expect(html).not.toContain("A reply wasn’t completed");
  });
  it("places a manual quote card directly below the concise answer without exposing extraction JSON", () => {
    if (!completeTurn.reply) {
      throw new Error("Missing reply fixture");
    }
    const id = crypto.randomUUID();
    const html = render(
      {
        ...completeTurn,
        reply: {
          ...completeTurn.reply,
          content: '{"clarification":null,"intent":{"kind":"spot"}}',
          manual: { text: "Review your quote below.", tradeIds: [id] },
        },
      },
      false,
    );
    expect(html).toContain(id);
    expect(html).toContain('aria-label="Trade confirmation"');
    expect(html.indexOf("Review your quote below.</p><section")).toBeGreaterThan(-1);
    expect(html).toContain("Confirm trade");
    expect(html).not.toContain("clarification");
    expect(html).not.toContain("Research snapshot");
  });
  it("keeps the avatar, text, table and code in identical message ancestors after completion", () => {
    const provisional = render(pendingTurn, true);
    const completed = render(completeTurn, false);
    // Include the complete rich-text body and all of its width/spacing ancestors, excluding the changing footer.
    const bodyEnd = provisional.indexOf("</pre>") + "</pre>".length;
    expect(bodyEnd).toBeGreaterThan("</pre>".length);
    expect(provisional.slice(0, bodyEnd)).toBe(completed.slice(0, bodyEnd));
    expect(provisional).toContain("Verification pending");
    expect(provisional).not.toContain("Model response verified");
    expect(provisional).not.toContain("Create agent");
    expect(completed).toContain("Model response verified");
    expect(completed).not.toContain("Verification pending");
  });

  it("removes provisional content when a turn fails", () => {
    const failed = render({ ...pendingTurn, state: "failed" }, true);
    expect(failed).not.toContain("Wait for confirmation.");
    expect(failed).not.toContain("Verification pending");
    expect(failed).toContain("Try again");
  });

  it("uses the saved answer even while the previous preview is retained during the cache handoff", () => {
    const completed = render(completeTurn, false);
    expect(render(completeTurn, true, "Earlier provisional content")).toBe(completed);
  });

  it("does not append research snapshot cards or agent actions to a saved analysis", () => {
    if (!completeTurn.reply) {
      throw new Error("Missing reply fixture");
    }
    const html = render(
      {
        ...completeTurn,
        reply: {
          ...completeTurn.reply,
          research: [
            {
              tool: "arbitrage",
              status: "partial",
              summary: "Research snapshot",
              observedAt: 1000,
              items: [],
              sources: [],
              limitations: [],
            },
          ],
        },
      },
      false,
    );
    expect(html).toContain("Wait for confirmation.");
    expect(html).not.toContain("Research snapshot");
    expect(html).not.toContain("Data and sources");
    expect(html).not.toContain("Create agent");
  });
});
