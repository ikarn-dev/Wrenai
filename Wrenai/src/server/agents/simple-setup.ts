import "server-only";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { type ChatCipher, chatCipher } from "@/server/chat/cipher";
import { ChatError } from "@/server/chat/errors";
import { agentEvents, strategyDrafts } from "@/server/db/agent-schema";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { executionHash } from "@/server/execution/records";
import type { IntentToken } from "@/server/research/intents";
import { isActiveAgentTool } from "@/shared/agent-scope";
import type { saveAgentWithBudgetSchema } from "@/shared/agents";
import { agentSetupDraftSchema } from "@/shared/research";
import { AgentError } from "./errors";
import { saveAgent } from "./mutations";
import { setupBindingHash } from "./setup-binding";
import { prepareAgentBudget, reserveSetupBudget } from "./token-budgets";

type Input = z.infer<typeof saveAgentWithBudgetSchema>;
export async function recoverCreatedAgent(
  db: AppDatabase,
  owner: string,
  input: Input,
): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.id, input.requestId),
        eq(agentEvents.userId, owner),
        eq(agentEvents.kind, "agent_creation_review"),
      ),
    )
    .limit(1);
  if (!row) {
    return undefined;
  }
  if (!row.agentId || row.detailJson !== JSON.stringify({ inputHash: executionHash(input) })) {
    throw new AgentError(
      "conflict",
      "This request already created an agent with different instructions or funds.",
    );
  }
  return row.agentId;
}

/** Instructions, a wallet reservation and the paused agent commit together. No keys or transfers. */
export async function saveAgentWithBudget(
  db: AppDatabase,
  owner: string,
  input: Input,
  tokens: readonly IntentToken[],
  cipher: ChatCipher = chatCipher(),
): Promise<string> {
  const recovered = await recoverCreatedAgent(db, owner, input);
  if (recovered) {
    return recovered;
  }
  if (input.agentId !== null || Boolean(input.setupId) !== Boolean(input.setupHash)) {
    throw new AgentError("invalid_input", "Review the existing agent or saved setup before making changes.");
  }
  const [draft] = await db
    .select()
    .from(strategyDrafts)
    .where(and(eq(strategyDrafts.id, input.draftId), eq(strategyDrafts.userId, owner)))
    .limit(1);
  if (!draft || !isActiveAgentTool(draft.pack)) {
    throw new AgentError("not_found", "The reviewed strategy could not be found.");
  }
  if (!input.budget) {
    throw new AgentError("invalid_input", "Choose the token and amount for this agent.");
  }
  if (input.policy.approvalMode !== "autonomous") {
    throw new AgentError(
      "invalid_input",
      "Review autonomous execution within your limits before creating this agent.",
    );
  }
  const prepared = await prepareAgentBudget(db, owner, input.budget);
  try {
    return await userTransaction(db, owner, async (tx) => {
      const repeated = await recoverCreatedAgent(tx, owner, input);
      if (repeated) {
        return repeated;
      }
      const setupId = input.setupId ?? input.requestId;
      const [row] = await tx
        .select()
        .from(chatAgentDrafts)
        .where(eq(chatAgentDrafts.id, setupId))
        .for("update")
        .limit(1);
      const previous =
        row && row.userId === owner
          ? agentSetupDraftSchema.parse(
              JSON.parse(cipher.open(owner, row.id, "agent-setup", row.sealedDraft)),
            )
          : null;
      if (
        row &&
        (!previous ||
          !input.setupId ||
          previous.agentId ||
          previous.tool !== draft.pack ||
          setupBindingHash(previous) !== input.setupHash)
      ) {
        throw new AgentError(
          "conflict",
          "This setup changed or already belongs to an agent. Refresh its review.",
        );
      }
      if (input.setupId && !row) {
        throw new AgentError("not_found", "The saved setup could not be found.");
      }
      if (!row) {
        const owned = await tx
          .select({ id: chatAgentDrafts.id })
          .from(chatAgentDrafts)
          .where(eq(chatAgentDrafts.userId, owner))
          .limit(100);
        if (owned.length >= 100) {
          throw new AgentError("invalid_input", "Discard an unused setup before creating another agent.");
        }
      }
      const setup = agentSetupDraftSchema.parse({
        ...previous,
        id: setupId,
        tool: draft.pack,
        brief: draft.strategyText,
        reports: previous?.reports ?? [],
        createdAt: previous?.createdAt ?? Date.now(),
        reviewState: "reviewed",
        budget: await reserveSetupBudget(tx, owner, setupId, prepared, cipher, previous?.budget),
      });
      const sealedDraft = cipher.seal(owner, setup.id, "agent-setup", JSON.stringify(setup));
      if (row) {
        await tx.update(chatAgentDrafts).set({ sealedDraft }).where(eq(chatAgentDrafts.id, setup.id));
      } else {
        await tx.insert(chatAgentDrafts).values({
          id: setup.id,
          userId: owner,
          sourceType: "manual",
          conversationId: null,
          turnId: null,
          tool: setup.tool,
          sealedDraft,
          createdAt: setup.createdAt,
        });
      }
      const { budget: _budget, ...saved } = input;
      const agentId = await saveAgent(
        tx,
        owner,
        { ...saved, setupId: setup.id, setupHash: setupBindingHash(setup) },
        cipher,
        tokens,
        prepared.holding.assetId,
      );
      await tx.insert(agentEvents).values({
        id: input.requestId,
        userId: owner,
        agentId,
        kind: "agent_creation_review",
        message: "Created the reviewed agent and reserved its selected token budget.",
        detailJson: JSON.stringify({ inputHash: executionHash(input) }),
        createdAt: Date.now(),
      });
      return agentId;
    });
  } catch (error) {
    if (error instanceof ChatError) {
      throw new AgentError(error.code === "invalid_input" ? "invalid_input" : "not_ready", error.message);
    }
    throw error;
  }
}
