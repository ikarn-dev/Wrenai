import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceError, type VerifiedCompletion } from "@/server/ai/verified-completion";
import { chatCipher } from "@/server/chat/cipher";
import { readConversation } from "@/server/chat/queries";
import { answerChat } from "@/server/chat/service";
import { claimChatTurn } from "@/server/chat/turns";
import type { ChatEvent, ChatInput, ChatTurn } from "@/shared/chat";

const cloud = vi.hoisted(() => ({
  complete: vi.fn(),
  context: vi.fn(),
  prepare: vi.fn(),
  title: vi.fn(),
  cacheRead: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/chat/research-answer", () => ({ researchAnswer: cloud.complete }));
vi.mock("@/server/chat/redis-cache", () => ({
  readChatCache: cloud.cacheRead,
  writeChatCache: async () => false,
}));
vi.mock("@/server/chat/context", () => ({ readChatContext: cloud.context }));
vi.mock("@/server/ai/chat-preparation", () => ({ prepareChatInference: cloud.prepare }));
vi.mock("@/server/chat/title", () => ({ generateChatTitle: cloud.title }));

const user = { id: "owner", accountId: "owner.near" };
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 19)));
const completion: VerifiedCompletion = {
  content: "Liquidity pools hold assets for swaps; returns and principal are at risk.",
  receipt: {
    model: "Qwen/Qwen3.8-27B",
    completionId: "service-test",
    signatureKind: "provider_tee",
    verifiedAt: 1_000,
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    evidenceHash: "c".repeat(64),
    evidenceJson: '{"test":"receipt"}',
  },
};
let store: Awaited<ReturnType<typeof testDatabase>>;
let input: ChatInput;

describe("read-only chat response lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store = await testDatabase();
    input = {
      conversationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      previousTurnId: null,
      message: "How do liquidity pools work?",
      includeContext: false,
    };
    cloud.complete.mockResolvedValue({ ...completion, reports: [] });
    cloud.prepare.mockResolvedValue(undefined);
    cloud.title.mockResolvedValue(null);
    cloud.cacheRead.mockResolvedValue(null);
  });
  afterEach(async () => {
    await store.postgres.close();
  });

  it("answers and saves once, without reading private account context unless requested", async () => {
    const first = await answerChat(store.db, user, input, cipher);
    const duplicate = await answerChat(store.db, user, input, cipher);
    expect(first.reply?.content).toBe(completion.content);
    expect(duplicate).toEqual(first);
    expect(cloud.complete).toHaveBeenCalledTimes(1);
    expect(cloud.context).not.toHaveBeenCalled();
    expect(cloud.complete.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect((await readConversation(store.db, user.id, input.conversationId, cipher)).turns).toHaveLength(1);
  });

  it("rejects a conflicting selection before claiming a turn, loading context or preparing inference", async () => {
    await expect(
      answerChat(
        store.db,
        user,
        {
          ...input,
          message: "Compare current NEAR yield opportunities",
          tool: "triggers",
          includeContext: true,
        },
        cipher,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(cloud.prepare).not.toHaveBeenCalled();
    expect(cloud.context).not.toHaveBeenCalled();
    expect(cloud.complete).not.toHaveBeenCalled();
    await expect(readConversation(store.db, user.id, input.conversationId, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("starts context and attestation preparation while the optional history cache is still loading", async () => {
    const first = await answerChat(store.db, user, input, cipher);
    vi.clearAllMocks();
    const deferred: { resolve?: (value: ChatTurn[]) => void } = {};
    cloud.cacheRead.mockImplementationOnce(
      () =>
        new Promise<ChatTurn[]>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    cloud.context.mockResolvedValue({
      readAt: 1000,
      accountId: user.accountId,
      wallet: { kind: "unavailable" },
      agents: [],
      agentsTruncated: false,
    });
    const pending = answerChat(
      store.db,
      user,
      { ...input, requestId: crypto.randomUUID(), previousTurnId: first.id, includeContext: true },
      cipher,
    );
    await vi.waitFor(() => expect(cloud.cacheRead).toHaveBeenCalledTimes(1));
    expect(cloud.prepare).toHaveBeenCalledTimes(1);
    expect(cloud.context).toHaveBeenCalledTimes(1);
    expect(cloud.complete).not.toHaveBeenCalled();
    if (!deferred.resolve) {
      throw new Error("History lookup did not start");
    }
    deferred.resolve([first]);
    expect((await pending).state).toBe("complete");
  });

  it("emits the saved answer before a delayed title and keeps the metadata stream usable", async () => {
    const deferred: { resolve?: (value: string) => void } = {};
    cloud.title.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const events: ChatEvent[] = [];
    const pending = answerChat(store.db, user, input, cipher, undefined, (event) => events.push(event));
    await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true));
    expect((await readConversation(store.db, user.id, input.conversationId, cipher)).turns[0]?.state).toBe(
      "complete",
    );
    if (!deferred.resolve) {
      throw new Error("Title generation did not start");
    }
    deferred.resolve("Liquidity pool risks");
    await pending;
    expect(events.at(-1)).toEqual({ type: "title", title: "Liquidity pool risks" });
  });

  it("never marks a saved reply as failed when optional title metadata fails", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      cloud.title.mockRejectedValueOnce(new Error("private optional metadata detail"));
      const saved = await answerChat(store.db, user, input, cipher);
      expect(saved.state).toBe("complete");
      expect(
        (await readConversation(store.db, user.id, input.conversationId, cipher)).turns[0]?.reply?.content,
      ).toBe(completion.content);
      expect(warning).toHaveBeenCalledWith(expect.not.stringContaining("private"), {
        code: "WRENAI_CHAT_METADATA",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("passes the selected tool into verified research and retains it on the saved turn", async () => {
    const saved = await answerChat(
      store.db,
      user,
      { ...input, message: "Find NEAR arbitrage opportunities", tool: "arbitrage" },
      cipher,
    );
    expect(saved.tool).toBe("arbitrage");
    expect(cloud.complete.mock.calls[0]?.[3]).toBe("arbitrage");
    expect(JSON.stringify(cloud.complete.mock.calls[0]?.[0])).toContain("The user selected Arbitrage");
  });

  it("supplies a fresh owner-scoped snapshot only after explicit opt-in", async () => {
    const context = {
      readAt: Date.now(),
      accountId: user.accountId,
      wallet: { kind: "unavailable" },
      agents: [],
      agentsTruncated: false,
    };
    cloud.context.mockResolvedValue(context);
    const result = await answerChat(store.db, user, { ...input, includeContext: true }, cipher);
    expect(cloud.context).toHaveBeenCalledWith(store.db, user);
    expect(result.reply?.context).toEqual(context);
    expect(JSON.stringify(cloud.complete.mock.calls[0]?.[0])).toContain("Fresh read-only account snapshot");
    expect(JSON.stringify(cloud.complete.mock.calls[0]?.[0])).toContain("unavailable");
  });

  it("never saves an unverified answer, and retries a failed turn without duplicating its user message", async () => {
    cloud.complete.mockRejectedValueOnce(
      new InferenceError("verification_failed", "Response verification failed."),
    );
    await expect(answerChat(store.db, user, input, cipher)).rejects.toMatchObject({
      code: "verification_failed",
    });
    const failed = await readConversation(store.db, user.id, input.conversationId, cipher);
    expect(failed.turns[0]?.state).toBe("failed");
    expect(failed.turns[0]?.reply).toBeNull();
    await answerChat(store.db, user, input, cipher);
    expect((await readConversation(store.db, user.id, input.conversationId, cipher)).turns).toHaveLength(1);
  });

  it("saves and reopens a streamed DeepSeek answer with large complete verification evidence", async () => {
    cloud.complete.mockResolvedValue({
      ...completion,
      reports: [],
      receipt: {
        ...completion.receipt,
        model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        evidenceJson: JSON.stringify({ certificate: "provider-evidence".repeat(21000) }),
      },
    });
    const events: string[] = [];
    const result = await answerChat(store.db, user, input, cipher, undefined, (event) =>
      events.push(event.type),
    );
    expect(result.state).toBe("complete");
    expect(events.at(-1)).toBe("done");
    expect(
      (await readConversation(store.db, user.id, input.conversationId, cipher)).turns[0]?.reply?.content,
    ).toBe(completion.content);
  });

  it("refuses model output that arrives after the user stopped the response", async () => {
    const deferred: { resolve?: (value: VerifiedCompletion & { reports: [] }) => void } = {};
    cloud.complete.mockImplementation(
      () =>
        new Promise<VerifiedCompletion & { reports: [] }>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const pending = answerChat(store.db, user, input, cipher);
    const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
    await vi.waitFor(() => expect(cloud.complete).toHaveBeenCalledTimes(1));
    await claimChatTurn(store.db, user.id, input, { cipher, cancel: true });
    if (!deferred.resolve) {
      throw new Error("Model was not requested");
    }
    deferred.resolve({ ...completion, reports: [] });
    await rejected;
    const conversation = await readConversation(store.db, user.id, input.conversationId, cipher);
    expect(conversation.turns[0]?.state).toBe("cancelled");
    expect(conversation.turns[0]?.reply).toBeNull();
  });

  it("does not send inference for a conversation owned by another user", async () => {
    await claimChatTurn(store.db, user.id, input, { cipher });
    await expect(
      answerChat(store.db, { id: "stranger", accountId: "stranger.near" }, input, cipher),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(cloud.complete).not.toHaveBeenCalled();
  });
});
