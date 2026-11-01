import { createSecretKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttestationReceipt } from "@/server/ai/attestation-receipt";
import { chatConversations, chatTurns } from "@/server/db/chat-schema";
import { testDatabase } from "@/server/db/test-database";
import type { ChatInput, ChatReply } from "@/shared/chat";
import { chatCipher } from "./cipher";
import { chatPrompt } from "./prompt";
import { conversationHistory, listConversations, readConversation } from "./queries";
import { claimChatTurn, deleteConversation, finishChatTurn } from "./turns";

vi.mock("server-only", () => ({}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 17)));
let store: Awaited<ReturnType<typeof testDatabase>>;
let input: ChatInput;
const receipt: AttestationReceipt = {
  model: "Qwen/Qwen3.8-27B",
  completionId: "test-completion",
  signatureKind: "provider_tee",
  verifiedAt: 1_000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: '{"test":"attestation evidence"}',
};
const reply: ChatReply = {
  content: "An explanation, without any executed action.",
  receipt: {
    model: receipt.model,
    completionId: receipt.completionId,
    signatureKind: receipt.signatureKind,
    verifiedAt: receipt.verifiedAt,
    evidenceHash: receipt.evidenceHash,
  },
  context: null,
  historyTrimmed: false,
};

async function claim(now = 1_000) {
  const result = await claimChatTurn(store.db, "owner", input, { cipher, now });
  if (result.kind !== "claimed") {
    throw new Error("Expected a new claim");
  }
  return result;
}

async function complete(token: string, now = 2_000) {
  return finishChatTurn(store.db, "owner", input, token, { state: "complete", reply, receipt }, cipher, now);
}

describe("saved chat ownership, idempotency and cancellation", () => {
  beforeEach(async () => {
    store = await testDatabase();
    input = {
      conversationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      previousTurnId: null,
      message: "Explain liquidity pools",
      includeContext: false,
    };
  });
  afterEach(async () => {
    await store.postgres.close();
  });

  it("persists encrypted titles, prompts, replies and verification evidence, and reads them back", async () => {
    const current = await claim();
    await complete(current.token);
    const conversation = await readConversation(store.db, "owner", input.conversationId, cipher);
    expect(conversation.title).toBe(input.message);
    expect(conversation.turns[0]?.reply).toEqual(reply);
    const stored = await store.db.select().from(chatTurns);
    const headers = await store.db.select().from(chatConversations);
    const storageText = JSON.stringify({ stored, headers });
    for (const text of [input.message, reply.content, "attestation evidence"]) {
      expect(storageText).not.toContain(text);
    }
    expect(await listConversations(store.db, "stranger", cipher)).toEqual([]);
  });

  it("denies another owner reads, writes, stop requests and deletion", async () => {
    await claim();
    await expect(readConversation(store.db, "stranger", input.conversationId, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(claimChatTurn(store.db, "stranger", input, { cipher, now: 2_000 })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      claimChatTurn(store.db, "stranger", input, { cipher, now: 2_000, cancel: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteConversation(store.db, "stranger", input.conversationId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await store.db.select().from(chatTurns)).toHaveLength(1);
  });

  it("blocks duplicate active inference, changed request input and stale concurrent messages", async () => {
    const current = await claim();
    await expect(claimChatTurn(store.db, "owner", input, { cipher, now: 2_000 })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      claimChatTurn(store.db, "owner", { ...input, message: "Different input" }, { cipher, now: 2_000 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      claimChatTurn(store.db, "owner", { ...input, requestId: crypto.randomUUID() }, { cipher, now: 2_000 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await complete(current.token);
    const cached = await claimChatTurn(store.db, "owner", input, { cipher, now: 3_000 });
    expect(cached.kind).toBe("cached");
    expect(cached.turn.reply).toEqual(reply);
    expect(await store.db.select().from(chatTurns)).toHaveLength(1);
  });

  it("fences expired and failed attempts before a retry can publish a response", async () => {
    const first = await claim();
    const replacement = await claim(122_000);
    expect(replacement.token).not.toBe(first.token);
    await expect(complete(first.token, 123_000)).rejects.toMatchObject({ code: "conflict" });
    await finishChatTurn(store.db, "owner", input, replacement.token, { state: "failed" }, cipher, 123_000);
    const retry = await claim(124_000);
    await expect(complete(replacement.token, 125_000)).rejects.toMatchObject({ code: "conflict" });
    expect((await complete(retry.token, 125_000)).state).toBe("complete");
  });

  it("stops an active response and refuses its late completion", async () => {
    const current = await claim();
    const stopped = await claimChatTurn(store.db, "owner", input, { cipher, now: 2_000, cancel: true });
    expect(stopped.turn.state).toBe("cancelled");
    await expect(complete(current.token)).rejects.toMatchObject({ code: "conflict" });
    expect((await claimChatTurn(store.db, "owner", input, { cipher, now: 3_000 })).kind).toBe("cached");
    expect((await store.db.select().from(chatTurns))[0]?.sealedReply).toBeNull();
  });

  it("remembers a stop that arrives before the original send", async () => {
    const stopped = await claimChatTurn(store.db, "owner", input, { cipher, now: 1_000, cancel: true });
    expect(stopped.turn.state).toBe("cancelled");
    const delayed = await claimChatTurn(store.db, "owner", input, { cipher, now: 2_000 });
    expect(delayed.kind).toBe("cached");
    expect(delayed.turn.state).toBe("cancelled");
  });

  it("clears deleted chat text and prevents delayed first sends from recreating it", async () => {
    const current = await claim();
    await complete(current.token);
    await deleteConversation(store.db, "owner", input.conversationId);
    expect(await store.db.select().from(chatTurns)).toEqual([]);
    const [tombstone] = await store.db.select().from(chatConversations);
    expect(tombstone?.sealedTitle).toBeNull();
    expect(tombstone?.deletedAt).toBeTypeOf("number");
    expect(await listConversations(store.db, "owner", cipher)).toEqual([]);
    await expect(readConversation(store.db, "owner", input.conversationId, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(claimChatTurn(store.db, "owner", input, { cipher, now: 3_000 })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(complete(current.token, 3_000)).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces conversation ownership in the database's composite foreign key", async () => {
    await claim();
    const [row] = await store.db.select().from(chatTurns).where(eq(chatTurns.id, input.requestId));
    if (!row) {
      throw new Error("Missing test turn");
    }
    await expect(
      store.db.insert(chatTurns).values({ ...row, id: crypto.randomUUID(), sequence: 2, userId: "stranger" }),
    ).rejects.toThrow();
  });

  it("loads bounded, chronological successful history and reports omitted older messages", async () => {
    const current = await claim();
    await complete(current.token);
    const [seed] = await store.db.select().from(chatTurns);
    if (!seed) {
      throw new Error("Missing fixture turn");
    }
    await store.db.insert(chatTurns).values(
      Array.from({ length: 29 }, (_value, index) => {
        const sequence = index + 2;
        const id = crypto.randomUUID();
        return {
          ...seed,
          id,
          sequence,
          sealedMessage: cipher.seal("owner", input.conversationId, `${id}:user`, `question-${sequence}`),
          state: sequence === 30 ? ("failed" as const) : ("complete" as const),
          sealedReply:
            sequence === 30
              ? null
              : cipher.seal(
                  "owner",
                  input.conversationId,
                  `${id}:assistant`,
                  JSON.stringify({
                    reply: { ...reply, content: `answer-${sequence}` },
                    attestation: receipt,
                  }),
                ),
        };
      }),
    );
    const history = await conversationHistory(store.db, "owner", input.conversationId, 31, cipher);
    expect(history).toHaveLength(25);
    expect(history[0]?.sequence).toBe(5);
    expect(history.at(-1)?.sequence).toBe(29);
    const prompt = chatPrompt(history, "latest", null, 1_000);
    expect(prompt.historyTrimmed).toBe(true);
    expect(prompt.messages[1]?.content).toBe("question-6");
    expect(prompt.messages.at(-2)?.content).toBe("answer-29");
    expect(await conversationHistory(store.db, "stranger", input.conversationId, 31, cipher)).toEqual([]);
    expect((await readConversation(store.db, "owner", input.conversationId, cipher)).turns).toHaveLength(30);
  });

  it("checks a reused request ID even when it belongs to a different conversation", async () => {
    const current = await claim();
    await complete(current.token);
    const other = { ...input, conversationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
    const second = await claimChatTurn(store.db, "owner", other, { cipher, now: 3_000 });
    if (second.kind !== "claimed") {
      throw new Error("Expected another conversation");
    }
    await finishChatTurn(
      store.db,
      "owner",
      other,
      second.token,
      { state: "complete", reply, receipt },
      cipher,
      4_000,
    );
    await expect(
      claimChatTurn(store.db, "owner", { ...other, requestId: input.requestId }, { cipher, now: 5_000 }),
    ).rejects.toThrow("message ID was already used");
    expect((await readConversation(store.db, "owner", other.conversationId, cipher)).turns[0]?.id).toBe(
      other.requestId,
    );
  });
});
