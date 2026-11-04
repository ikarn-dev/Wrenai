import { createSecretKey } from "node:crypto";
import {
  inputAssetId,
  manualContext,
  outputAssetId,
  preparedManualOrder,
} from "@tests/server/manual-trading/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InferenceError } from "@/server/ai/verified-completion";
import { chatCipher } from "@/server/chat/cipher";
import { readConversation } from "@/server/chat/queries";
import { answerChat } from "@/server/chat/service";
import { executionActions } from "@/server/db/execution-schema";
import { manualTrades } from "@/server/db/manual-schema";
import type { ChatInput } from "@/shared/chat";

const cloud = vi.hoisted(() => ({ stream: vi.fn(), prepare: vi.fn(), context: vi.fn(), quote: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/verified-chat-stream", () => ({ verifiedChatStream: cloud.stream }));
vi.mock("@/server/ai/chat-preparation", () => ({ prepareChatInference: cloud.prepare }));
vi.mock("@/server/chat/context", () => ({ readChatContext: cloud.context }));
vi.mock("@/server/chat/title", () => ({ generateChatTitle: async () => null }));
vi.mock("@/server/chat/redis-cache", () => ({
  readChatCache: async () => null,
  writeChatCache: async () => false,
}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline" }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: async () => {} }));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    tokens: [
      {
        assetId: inputAssetId,
        symbol: "USDC",
        blockchain: "near",
        decimals: 6,
        contractAddress: "usdc.test-fixture.near",
      },
      {
        assetId: outputAssetId,
        symbol: "wNEAR",
        blockchain: "near",
        decimals: 24,
        contractAddress: "wrap.near",
      },
    ],
  }),
}));
vi.mock("@/server/execution/intents-quote", () => ({
  prepareIntentsOrder: cloud.quote,
}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 19)));
const receipt = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  completionId: "offline-manual",
  signatureKind: "provider_tee",
  verifiedAt: 1000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: JSON.stringify({ certificate: "evidence".repeat(30000) }),
} as const;
let store: Awaited<ReturnType<typeof manualContext>>, input: ChatInput;
function extracted(amount: string) {
  return {
    content: JSON.stringify({
      clarification: null,
      intent: {
        kind: "spot",
        inputAssetId: "USDC",
        outputAssetId: "wNEAR",
        amount,
        balance: "confidential",
        slippageBps: 50,
        maximumFeeBps: 0,
      },
    }),
    calls: [],
    receipt,
  };
}
beforeEach(async () => {
  store = await manualContext();
  input = {
    conversationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    previousTurnId: null,
    message: "Swap 10 USDC for wNEAR with 0.5% slippage",
    includeContext: false,
  };
  cloud.stream.mockReset().mockResolvedValue(extracted("10"));
  cloud.prepare.mockReset().mockResolvedValue(undefined);
  cloud.context.mockReset().mockRejectedValue(new Error("Wallet context must not delay a quote"));
  cloud.quote
    .mockReset()
    .mockImplementation(async (raw: unknown) =>
      preparedManualOrder(z.object({ inputUnits: z.string() }).parse(raw).inputUnits),
    );
});
afterEach(async () => {
  await store.postgres.close();
});
describe("verified Jarvis manual quote persistence", () => {
  it("saves and reopens an exact quote and full receipt, follows up without executing or duplicating requests", async () => {
    const first = await answerChat(store.db, { id: "owner", accountId: "owner.near" }, input, cipher);
    const reopened = await readConversation(store.db, "owner", input.conversationId, cipher);
    expect(reopened.turns[0]?.reply?.manual).toEqual({
      text: "Review your quote below.",
      tradeIds: [input.requestId],
    });
    expect(first.reply?.content).toBe(extracted("10").content);
    expect(await store.db.select().from(executionActions)).toHaveLength(0);
    expect(await store.db.select().from(manualTrades)).toHaveLength(1);
    await answerChat(store.db, { id: "owner", accountId: "owner.near" }, input, cipher);
    expect(cloud.stream).toHaveBeenCalledTimes(1);
    cloud.stream.mockResolvedValueOnce(extracted("5"));
    const second = await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        ...input,
        requestId: crypto.randomUUID(),
        previousTurnId: first.id,
        message: "Swap 5 USDC for wNEAR with 0.5% slippage",
      },
      cipher,
    );
    expect(second.reply?.manual?.tradeIds).toHaveLength(1);
    expect(await store.db.select().from(manualTrades)).toHaveLength(2);
    expect(await store.db.select().from(executionActions)).toHaveLength(0);
  });
  it("never creates a quote from failed model verification", async () => {
    cloud.stream.mockRejectedValueOnce(new InferenceError("verification_failed", "Rejected"));
    await expect(
      answerChat(store.db, { id: "owner", accountId: "owner.near" }, input, cipher),
    ).rejects.toMatchObject({ code: "verification_failed" });
    expect(await store.db.select().from(manualTrades)).toHaveLength(0);
    expect(
      (await readConversation(store.db, "owner", input.conversationId, cipher)).turns[0]?.reply,
    ).toBeNull();
  });
  it("answers a plain exact quote through the verified model and saves its receipt with the card", async () => {
    cloud.stream.mockResolvedValueOnce(extracted("10"));
    const turn = await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      { ...input, message: "Quote 10 USDC to wNEAR" },
      cipher,
    );
    expect(cloud.stream).toHaveBeenCalledTimes(1);
    expect(turn.reply?.receipt?.completionId).toBe("offline-manual");
    expect(turn.reply?.manual).toEqual({ text: "Review your quote below.", tradeIds: [input.requestId] });
    expect(await store.db.select().from(manualTrades)).toHaveLength(1);
    expect(await store.db.select().from(executionActions)).toHaveLength(0);
  });
  it("saves no quote and no reply when the model is unavailable", async () => {
    cloud.stream.mockRejectedValueOnce(new InferenceError("unavailable", "Offline"));
    await expect(
      answerChat(
        store.db,
        { id: "owner", accountId: "owner.near" },
        { ...input, message: "Quote 10 USDC to wNEAR" },
        cipher,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await store.db.select().from(manualTrades)).toHaveLength(0);
  });
  it("turns malformed but verified extraction into one clarification instead of a failed chat", async () => {
    cloud.stream.mockResolvedValueOnce({ ...extracted("10"), content: "not valid JSON" });
    const reply = await answerChat(store.db, { id: "owner", accountId: "owner.near" }, input, cipher);
    expect(reply.state).toBe("complete");
    expect(reply.reply?.manual?.text).toContain("tokens and amount");
    expect(reply.reply?.manual?.tradeIds).toEqual([]);
    expect(reply.reply?.receipt?.signatureKind).toBe("provider_tee");
    expect(await store.db.select().from(manualTrades)).toHaveLength(0);
  });
  it("asks only for missing details and never creates an order for an incomplete quote", async () => {
    cloud.stream.mockResolvedValueOnce({
      ...extracted("10"),
      content: JSON.stringify({ clarification: "Which token should I sell, and how much?", intent: null }),
    });
    const turn = await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        ...input,
        message: "Quote a swap",
      },
      cipher,
    );
    expect(turn.reply?.manual).toEqual({ text: "Which token should I sell, and how much?", tradeIds: [] });
    expect(await store.db.select().from(manualTrades)).toHaveLength(0);
    expect(await store.db.select().from(executionActions)).toHaveLength(0);
  });
  it("preserves the selected tool instead of silently creating an unrelated trade card", async () => {
    const turn = await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        ...input,
        tool: "perps",
        message: "Quote 10 USDC to wNEAR",
      },
      cipher,
    );
    expect(turn.reply?.manual).toEqual({
      text: "Choose Spot Trader or Auto to review this quote.",
      tradeIds: [],
    });
    expect(await store.db.select().from(manualTrades)).toHaveLength(0);
    expect(await store.db.select().from(executionActions)).toHaveLength(0);
  });
});
