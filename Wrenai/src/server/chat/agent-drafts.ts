import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { chatAgentDrafts, chatConversations, chatTurns } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { type AgentSetupDraft, agentSetupDraftSchema, type ResearchTool } from "@/shared/research";
import { type ChatCipher, chatCipher } from "./cipher";
import { ChatError } from "./errors";
import { displayTurn } from "./queries";

function openDraft(row: typeof chatAgentDrafts.$inferSelect, cipher: ChatCipher): AgentSetupDraft {
  return agentSetupDraftSchema.parse(
    JSON.parse(cipher.open(row.userId, row.id, "agent-setup", row.sealedDraft)),
  );
}
export async function readAgentSetup(
  db: AppDatabase,
  owner: string,
  id: string,
  cipher: ChatCipher = chatCipher(),
): Promise<AgentSetupDraft> {
  const [row] = await db
    .select()
    .from(chatAgentDrafts)
    .where(and(eq(chatAgentDrafts.id, id), eq(chatAgentDrafts.userId, owner)))
    .limit(1);
  if (!row) {
    throw new ChatError("not_found", "Setup draft not found.");
  }
  return openDraft(row, cipher);
}
export async function listAgentSetups(
  db: AppDatabase,
  owner: string,
  cipher: ChatCipher = chatCipher(),
): Promise<readonly AgentSetupDraft[]> {
  const rows = await db
    .select()
    .from(chatAgentDrafts)
    .where(eq(chatAgentDrafts.userId, owner))
    .orderBy(desc(chatAgentDrafts.createdAt))
    .limit(100);
  return rows.map((row) => openDraft(row, cipher));
}
/** Copies only a saved verified owner reply, never client-supplied research or a provisional stream. */
export async function createAgentSetup(
  db: AppDatabase,
  owner: string,
  conversationId: string,
  turnId: string,
  tool: ResearchTool,
  cipher: ChatCipher = chatCipher(),
): Promise<AgentSetupDraft> {
  return userTransaction(db, owner, async (tx) => {
    const [conversation] = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.userId, owner),
          eq(chatConversations.id, conversationId),
          isNull(chatConversations.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) {
      throw new ChatError("not_found", "Conversation not found.");
    }
    const [existing] = await tx
      .select()
      .from(chatAgentDrafts)
      .where(
        and(
          eq(chatAgentDrafts.userId, owner),
          eq(chatAgentDrafts.turnId, turnId),
          eq(chatAgentDrafts.tool, tool),
        ),
      )
      .limit(1);
    if (existing) {
      return openDraft(existing, cipher);
    }
    const [row] = await tx
      .select()
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.userId, owner),
          eq(chatTurns.conversationId, conversationId),
          eq(chatTurns.id, turnId),
        ),
      )
      .limit(1);
    if (row?.state !== "complete") {
      throw new ChatError("conflict", "Wait for a verified, saved answer before creating a setup.");
    }
    const turn = displayTurn(row, cipher);
    const reports =
      turn.reply?.research?.filter((report) => report.tool === tool && report.status !== "unavailable") ?? [];
    if (!reports.length) {
      throw new ChatError("invalid_input", "No available saved research exists for this tool.");
    }
    const brief = [turn.message, turn.reply?.content ?? ""].join("\n\n");
    const draft = agentSetupDraftSchema.parse({
      id: randomUUID(),
      tool,
      brief: brief.slice(0, 4000),
      briefTruncated: brief.length > 4000,
      reviewState: "draft",
      reports,
      createdAt: Date.now(),
    });
    await tx.insert(chatAgentDrafts).values({
      id: draft.id,
      userId: owner,
      conversationId,
      turnId,
      tool,
      sealedDraft: cipher.seal(owner, draft.id, "agent-setup", JSON.stringify(draft)),
      createdAt: draft.createdAt,
    });
    return draft;
  });
}
export async function updateAgentSetup(
  db: AppDatabase,
  owner: string,
  id: string,
  brief: string | null,
  cipher: ChatCipher = chatCipher(),
  reviewed = false,
): Promise<null> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(chatAgentDrafts)
      .where(and(eq(chatAgentDrafts.userId, owner), eq(chatAgentDrafts.id, id)))
      .for("update")
      .limit(1);
    if (!row) {
      throw new ChatError("not_found", "Setup draft not found.");
    }
    if (brief === null) {
      await tx.delete(chatAgentDrafts).where(eq(chatAgentDrafts.id, row.id));
      return;
    }
    const draft = agentSetupDraftSchema.parse({
      ...openDraft(row, cipher),
      brief,
      reviewState: reviewed ? "reviewed" : "draft",
    });
    await tx
      .update(chatAgentDrafts)
      .set({ sealedDraft: cipher.seal(owner, id, "agent-setup", JSON.stringify(draft)) })
      .where(eq(chatAgentDrafts.id, row.id));
  });
  return null;
}

export async function createManualAgentSetup(
  db: AppDatabase,
  owner: string,
  id: string,
  tool: ResearchTool,
  answers: readonly string[],
  notes: string,
  cipher: ChatCipher = chatCipher(),
): Promise<AgentSetupDraft> {
  const fields = AGENT_CATALOG[tool].fields;
  const brief =
    fields.map((field, index) => `${field}: ${answers[index] ?? ""}`).join("\n") +
    (notes ? `\nAdditional instructions: ${notes}` : "");
  return userTransaction(db, owner, async (tx) => {
    const [existing] = await tx.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.id, id)).limit(1);
    if (existing) {
      if (existing.userId !== owner) {
        throw new ChatError("not_found", "Setup not found.");
      }
      const draft = openDraft(existing, cipher);
      if (existing.sourceType !== "manual" || draft.tool !== tool || draft.brief !== brief) {
        throw new ChatError("conflict", "This request already saved a different setup. Reload to review it.");
      }
      return draft;
    }
    const owned = await tx
      .select({ id: chatAgentDrafts.id })
      .from(chatAgentDrafts)
      .where(eq(chatAgentDrafts.userId, owner))
      .limit(100);
    if (owned.length >= 100) {
      throw new ChatError("invalid_input", "Discard an old setup before creating another.");
    }
    const draft = agentSetupDraftSchema.parse({
      id,
      tool,
      brief,
      reports: [],
      createdAt: Date.now(),
      reviewState: "draft",
    });
    await tx.insert(chatAgentDrafts).values({
      id,
      userId: owner,
      sourceType: "manual",
      conversationId: null,
      turnId: null,
      tool,
      sealedDraft: cipher.seal(owner, id, "agent-setup", JSON.stringify(draft)),
      createdAt: draft.createdAt,
    });
    return draft;
  });
}
