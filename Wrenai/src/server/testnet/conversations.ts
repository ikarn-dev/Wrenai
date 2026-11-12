import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ConversationSummary } from "@/shared/chat";
import { TestnetError, testnetCipher } from "./config";
import type { TestnetDatabase } from "./database";
import { tnConversations, tnMessages, tnOwners } from "./schema";

export async function ensureTestnetConversation(
  db: TestnetDatabase,
  owner: string,
  id: string,
  title: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [person] = await tx.select().from(tnOwners).where(eq(tnOwners.id, owner)).for("update");
    if (!person) {
      throw new TestnetError("unauthorized", "Start a testnet session.");
    }
    const [existing] = await tx.select().from(tnConversations).where(eq(tnConversations.id, id));
    if (existing) {
      if (existing.ownerId !== owner || existing.deletedAt !== null) {
        throw new TestnetError("unauthorized", "This conversation is unavailable.");
      }
      return;
    }
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tnConversations)
      .where(and(eq(tnConversations.ownerId, owner), isNull(tnConversations.deletedAt)));
    if (count >= 100) {
      throw new TestnetError("limit", "Delete a conversation before creating another.");
    }
    await tx.insert(tnConversations).values({
      id,
      ownerId: owner,
      sealedTitle: testnetCipher().seal(owner, id, "title", title.slice(0, 64)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
export async function testnetConversationList(
  db: TestnetDatabase,
  owner: string,
): Promise<readonly ConversationSummary[]> {
  await importLegacyConversation(db, owner);
  const rows = await db
    .select()
    .from(tnConversations)
    .where(and(eq(tnConversations.ownerId, owner), isNull(tnConversations.deletedAt)))
    .orderBy(desc(tnConversations.updatedAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    title: testnetCipher().open(owner, r.id, "title", r.sealedTitle),
    updatedAt: r.updatedAt,
  }));
}
export async function removeTestnetConversation(
  db: TestnetDatabase,
  owner: string,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tnConversations)
      .where(and(eq(tnConversations.id, id), eq(tnConversations.ownerId, owner)))
      .for("update");
    if (!row) {
      throw new TestnetError("unauthorized", "This conversation is unavailable.");
    }
    await tx.update(tnConversations).set({ deletedAt: Date.now() }).where(eq(tnConversations.id, id));
    await tx.delete(tnMessages).where(and(eq(tnMessages.ownerId, owner), eq(tnMessages.conversationId, id)));
  });
}
export async function testnetConversationMessages(
  db: TestnetDatabase,
  owner: string,
  id: string,
): Promise<Array<typeof tnMessages.$inferSelect>> {
  const [conversation] = await db
    .select()
    .from(tnConversations)
    .where(
      and(eq(tnConversations.id, id), eq(tnConversations.ownerId, owner), isNull(tnConversations.deletedAt)),
    );
  if (!conversation) {
    return [];
  }
  return db
    .select()
    .from(tnMessages)
    .where(and(eq(tnMessages.ownerId, owner), eq(tnMessages.conversationId, id)))
    .orderBy(asc(tnMessages.createdAt))
    .limit(200);
}

async function importLegacyConversation(db: TestnetDatabase, owner: string): Promise<void> {
  const [prior] = await db.select().from(tnConversations).where(eq(tnConversations.id, owner));
  if (prior) {
    return;
  }
  const [first] = await db
    .select()
    .from(tnMessages)
    .where(
      and(eq(tnMessages.ownerId, owner), eq(tnMessages.conversationId, owner), eq(tnMessages.role, "user")),
    )
    .orderBy(asc(tnMessages.createdAt))
    .limit(1);
  if (!first) {
    return;
  }
  const message = z
    .object({ text: z.string() })
    .parse(JSON.parse(testnetCipher().open(owner, first.id, "text", first.sealedText)));
  await ensureTestnetConversation(db, owner, owner, message.text);
}
