import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { testnetCipher } from "@/server/testnet/config";
import {
  ensureTestnetConversation,
  removeTestnetConversation,
  testnetConversationList,
  testnetConversationMessages,
} from "@/server/testnet/conversations";
import { tnConversations, tnMessages } from "@/server/testnet/schema";
import { testnetContext } from "./context";

let c: Awaited<ReturnType<typeof testnetContext>>;
beforeEach(async () => {
  c = await testnetContext();
});
afterEach(async () => {
  await c.postgres.close();
  vi.unstubAllEnvs();
});
describe("testnet history behind the shared Jarvis UI", () => {
  it("persists separate encrypted conversation titles and rejects another owner", async () => {
    const id = randomUUID();
    await ensureTestnetConversation(c.db, c.owner.id, id, "Quote my USDC");
    const [stored] = await c.db.select().from(tnConversations).where(eq(tnConversations.id, id));
    expect(stored?.sealedTitle).not.toContain("Quote my USDC");
    expect(await testnetConversationList(c.db, c.owner.id)).toMatchObject([{ id, title: "Quote my USDC" }]);
    expect(await testnetConversationList(c.db, c.stranger.id)).toEqual([]);
    await expect(ensureTestnetConversation(c.db, c.stranger.id, id, "Steal")).rejects.toThrow("unavailable");
    await expect(removeTestnetConversation(c.db, c.stranger.id, id)).rejects.toThrow("unavailable");
  });
  it("deletes saved messages and prevents a late response from recreating a deleted chat", async () => {
    const id = randomUUID(),
      messageId = randomUUID();
    await ensureTestnetConversation(c.db, c.owner.id, id, "A chat");
    await c.db.insert(tnMessages).values({
      id: messageId,
      ownerId: c.owner.id,
      conversationId: id,
      requestId: randomUUID(),
      role: "user",
      sealedText: testnetCipher().seal(
        c.owner.id,
        messageId,
        "text",
        JSON.stringify({ text: "A message", orderId: null }),
      ),
      createdAt: Date.now(),
    });
    expect(await testnetConversationMessages(c.db, c.owner.id, id)).toHaveLength(1);
    expect(await testnetConversationMessages(c.db, c.stranger.id, id)).toHaveLength(0);
    await removeTestnetConversation(c.db, c.owner.id, id);
    expect(await testnetConversationMessages(c.db, c.owner.id, id)).toHaveLength(0);
    expect(await testnetConversationList(c.db, c.owner.id)).toHaveLength(0);
    await expect(ensureTestnetConversation(c.db, c.owner.id, id, "Late reply")).rejects.toThrow(
      "unavailable",
    );
  });
  it("adopts pre-existing owner history without exposing or discarding its encrypted messages", async () => {
    const id = randomUUID();
    await c.db.insert(tnMessages).values({
      id,
      ownerId: c.owner.id,
      conversationId: c.owner.id,
      requestId: randomUUID(),
      role: "user",
      sealedText: testnetCipher().seal(
        c.owner.id,
        id,
        "text",
        JSON.stringify({ text: "Earlier question", orderId: null }),
      ),
      createdAt: Date.now(),
    });
    expect(await testnetConversationList(c.db, c.owner.id)).toMatchObject([
      { id: c.owner.id, title: "Earlier question" },
    ]);
    expect(await testnetConversationMessages(c.db, c.owner.id, c.owner.id)).toHaveLength(1);
    await removeTestnetConversation(c.db, c.owner.id, c.owner.id);
    expect(await testnetConversationList(c.db, c.owner.id)).toHaveLength(0);
  });
});
