import "server-only";
import { and, eq } from "drizzle-orm";
import { prepareAgentBudget, reserveSetupBudget, sameBudgetInput } from "@/server/agents/token-budgets";
import { type ChatCipher, chatCipher } from "@/server/chat/cipher";
import { ChatError } from "@/server/chat/errors";
import { agents } from "@/server/db/agent-schema";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { type AgentSetupDraft, agentSetupDraftSchema, type ResearchTool } from "@/shared/research";

function openDraft(row: typeof chatAgentDrafts.$inferSelect, cipher: ChatCipher): AgentSetupDraft {
  return agentSetupDraftSchema.parse(
    JSON.parse(cipher.open(row.userId, row.id, "agent-setup", row.sealedDraft)),
  );
}
async function assertSetupMutable(db: AppDatabase, owner: string, draft: AgentSetupDraft): Promise<void> {
  if (!draft.agentId) {
    return;
  }
  const [agent] = await db
    .select({ deletedAt: agents.deletedAt })
    .from(agents)
    .where(and(eq(agents.userId, owner), eq(agents.id, draft.agentId)))
    .limit(1);
  if (!agent || agent.deletedAt === null) {
    throw new ChatError(
      "conflict",
      "This setup belongs to a created agent. Manage its funding and strategy from the agent page.",
    );
  }
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
/** Deletes one of the owner's setup drafts. Drafts never run, so nothing else depends on them. */
export async function deleteAgentSetup(
  db: AppDatabase,
  owner: string,
  id: string,
  cipher: ChatCipher = chatCipher(),
): Promise<null> {
  return userTransaction(db, owner, async (tx) => {
    await assertSetupMutable(tx, owner, await readAgentSetup(tx, owner, id, cipher));
    const removed = await tx
      .delete(chatAgentDrafts)
      .where(and(eq(chatAgentDrafts.id, id), eq(chatAgentDrafts.userId, owner)))
      .returning({ id: chatAgentDrafts.id });
    if (removed.length === 0) {
      throw new ChatError("not_found", "That setup is already gone. Refresh to update the list.");
    }
    return null;
  });
}
export async function updateAgentSetup(
  db: AppDatabase,
  owner: string,
  id: string,
  brief: string | null,
  cipher: ChatCipher = chatCipher(),
  reviewed = false,
  budget?: AgentBudgetInput | null,
): Promise<null> {
  // Authenticate ownership before contacting a token contract for an update.
  await readAgentSetup(db, owner, id, cipher);
  const prepared = budget ? await prepareAgentBudget(db, owner, budget) : undefined;
  await userTransaction(db, owner, async (tx) => {
    const [row] = await tx
      .select()
      .from(chatAgentDrafts)
      .where(and(eq(chatAgentDrafts.userId, owner), eq(chatAgentDrafts.id, id)))
      .for("update")
      .limit(1);
    if (!row) {
      throw new ChatError("not_found", "Setup draft not found.");
    }
    const stored = openDraft(row, cipher);
    await assertSetupMutable(tx, owner, stored);
    if (brief === null) {
      await tx.delete(chatAgentDrafts).where(eq(chatAgentDrafts.id, row.id));
      return;
    }
    if (!isActiveAgentTool(stored.tool)) {
      throw new ChatError("invalid_input", REMOVED_AGENT_MESSAGE);
    }
    const draft = agentSetupDraftSchema.parse({
      ...stored,
      ...(budget === null
        ? { budget: undefined }
        : prepared
          ? {
              budget: await reserveSetupBudget(tx, owner, id, prepared, cipher, stored.budget),
            }
          : {}),
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
  budget?: AgentBudgetInput,
): Promise<AgentSetupDraft> {
  if (!isActiveAgentTool(tool)) {
    throw new ChatError("invalid_input", REMOVED_AGENT_MESSAGE);
  }
  const fields = AGENT_CATALOG[tool].fields;
  const brief =
    fields.map((field, index) => `${field}: ${answers[index] ?? ""}`).join("\n") +
    (notes ? `\nAdditional instructions: ${notes}` : "");
  const [repeated] = await db.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.id, id)).limit(1);
  function existingDraft(row: typeof chatAgentDrafts.$inferSelect): AgentSetupDraft {
    if (row.userId !== owner) {
      throw new ChatError("not_found", "Setup not found.");
    }
    const draft = openDraft(row, cipher);
    if (
      row.sourceType !== "manual" ||
      draft.tool !== tool ||
      draft.brief !== brief ||
      !sameBudgetInput(draft.budget, budget)
    ) {
      throw new ChatError("conflict", "This request already saved a different setup. Reload to review it.");
    }
    return draft;
  }
  if (repeated) {
    return existingDraft(repeated);
  }
  const prepared = budget ? await prepareAgentBudget(db, owner, budget) : undefined;
  return userTransaction(db, owner, async (tx) => {
    const [existing] = await tx.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.id, id)).limit(1);
    if (existing) {
      return existingDraft(existing);
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
      ...(prepared ? { budget: await reserveSetupBudget(tx, owner, id, prepared, cipher) } : {}),
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
