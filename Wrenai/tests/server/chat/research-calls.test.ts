import { describe, expect, it, vi } from "vitest";
import { isResearchClarification, parseResearchCalls } from "@/server/chat/research-calls";

vi.mock("server-only", () => ({}));
const call = {
  id: "one",
  type: "function",
  function: {
    name: "research_dca",
    arguments: '{"symbols":["wNEAR","USDC"],"amount":"1","amountAsset":"wNEAR"}',
  },
} as const;

describe("research call boundary", () => {
  it("allows a single missing-input question, not recommendations or long filler", () => {
    expect(isResearchClarification("Which asset pair should I compare?")).toBe(true);
    expect(isResearchClarification("How much NEAR should I use?")).toBe(true);
    expect(isResearchClarification("Go long now. Which market do you prefer?")).toBe(false);
    expect(isResearchClarification("Which market? Which amount?")).toBe(false);
    expect(isResearchClarification(`Which market ${"a".repeat(240)}?`)).toBe(false);
  });
  it("normalizes JSON property ordering and defaults to a shared request identity", () => {
    const first = parseResearchCalls([call])[0];
    const second = parseResearchCalls([
      {
        ...call,
        function: {
          ...call.function,
          arguments: '{ "amountAsset":"wNEAR", "amount":"1", "symbols":["wNEAR","USDC"] }',
        },
      },
    ])[0];
    expect(first?.key).toBe(second?.key);
    expect(first?.arguments).toBe('{"symbols":["wNEAR","USDC"],"amount":"1","amountAsset":"wNEAR"}');
  });
  it.each([
    "{",
    "null",
    '{"symbols":["NEAR"]}',
    '{"symbols":["NEAR","USDC"],"url":"https://example.org"}',
    '{"symbols":["NEAR","USDC"],"amount":"10"}',
    '{"symbols":["wNEAR","USDC"]}',
    '{"symbols":["NEAR","USDC"],"amount":"0","amountAsset":"NEAR"}',
  ])("rejects malformed or incomplete input %s", (args) => {
    expect(() =>
      parseResearchCalls([{ ...call, function: { ...call.function, arguments: args } }]),
    ).toThrow();
  });
});
