import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QuoteRequest } from "@/components/trading/quote-request";

vi.mock("@/server/manual-trading/actions", () => ({
  requestChatSpotQuote: vi.fn(),
  readManualOrder: vi.fn(),
  confirmManualOrder: vi.fn(),
  dismissManualOrder: vi.fn(),
  requestManualQuote: vi.fn(),
}));
const request = {
  requestId: "5637fe91-a6c8-4970-8840-93281a123fde",
  inputToken: "NEAR",
  outputToken: "USDC",
  amount: "0.1",
};
function render(cache: QueryClient): string {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: cache }, createElement(QuoteRequest, { request })),
  );
}
describe("independent live quote card", () => {
  it("shows live-price loading without exposing an executable confirmation", () => {
    const html = render(new QueryClient());
    expect(html).toContain("Getting a live quote…");
    expect(html).not.toContain("Confirm trade");
  });
  it("keeps a provider failure inside the card with retry and manual recovery", () => {
    const cache = new QueryClient();
    const quote = cache.getQueryCache().build(cache, { queryKey: ["chat-spot-quote", request.requestId] });
    quote.setState({
      status: "error",
      error: new Error("The quote provider is unavailable."),
      fetchStatus: "idle",
    });
    const html = render(cache);
    expect(html).toContain("The quote provider is unavailable.");
    expect(html).toContain("Retry quote");
    expect(html).toContain("Open Spot");
    expect(html).not.toContain("Confirm trade");
    expect(html).not.toContain("A reply wasn’t completed");
  });
});
