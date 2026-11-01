import { createSecretKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceError, type VerifiedCompletion } from "@/server/ai/verified-completion";
import { testDatabase } from "@/server/db/test-database";
import type { ChatInput } from "@/shared/chat";
import { chatCipher } from "./cipher";
import { readConversation } from "./queries";
import { answerChat } from "./service";
import { claimChatTurn } from "./turns";

const cloud = vi.hoisted(() => ({ complete: vi.fn(), context: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./research-answer", () => ({ researchAnswer: cloud.complete }));
vi.mock("./redis-cache", () => ({ readChatCache: async () => null, writeChatCache: async () => false }));
vi.mock("./context", () => ({ readChatContext: cloud.context }));

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
