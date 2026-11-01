import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCipher } from "@/server/chat/cipher";
import { readConversationPage } from "@/server/chat/queries";
import { claimChatTurn, deleteConversation, finishChatTurn } from "@/server/chat/turns";
import type { ChatInput } from "@/shared/chat";

vi.mock("server-only", () => ({}));
vi.mock("@/server/chat/redis-cache", () => ({
  readChatCache: async () => null,
  writeChatCache: async () => false,
}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 13)));
let store: Awaited<ReturnType<typeof testDatabase>>;
const receipt = {
  model: "Qwen/Qwen3.8-27B",
  completionId: "page-test",
  signatureKind: "provider_tee",
  verifiedAt: 1000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: "{}",
} as const;
describe("bounded owner-scoped chat pages", () => {
  beforeEach(async () => {
    store = await testDatabase();
  });
  afterEach(async () => {
    await store.postgres.close();
  });
  it("loads the newest twenty first, preserves ordering and invalidates revision on writes/deletion", async () => {
    const id = crypto.randomUUID();
    let previous: string | null = null;
    for (let sequence = 1; sequence <= 22; sequence++) {
      const input: ChatInput = {
        conversationId: id,
        requestId: crypto.randomUUID(),
        previousTurnId: previous,
        message: `Question ${sequence}`,
        includeContext: false,
      };
      const claim = await claimChatTurn(store.db, "owner", input, { cipher });
      if (claim.kind !== "claimed") {
        throw new Error("Expected claim");
      }
      await finishChatTurn(
        store.db,
        "owner",
        input,
        claim.token,
        {
          state: "complete",
          receipt,
          reply: {
            content: `Answer ${sequence}`,
            receipt: {
              model: receipt.model,
              completionId: receipt.completionId,
              signatureKind: receipt.signatureKind,
              verifiedAt: receipt.verifiedAt,
              evidenceHash: receipt.evidenceHash,
            },
            context: null,
            historyTrimmed: false,
          },
        },
        cipher,
      );
      previous = input.requestId;
    }
    const latest = await readConversationPage(store.db, "owner", id, null, cipher);
    expect(latest.turns.map((turn) => turn.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    expect(latest.hasEarlier).toBe(true);
    const earlier = await readConversationPage(store.db, "owner", id, 3, cipher);
    expect(earlier.turns.map((turn) => turn.sequence)).toEqual([1, 2]);
    expect(earlier.hasEarlier).toBe(false);
    expect(latest.revision).toBeGreaterThan(22);
    await expect(readConversationPage(store.db, "stranger", id, null, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
    await deleteConversation(store.db, "owner", id);
    await expect(readConversationPage(store.db, "owner", id, null, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
