import "server-only";
import { and, eq } from "drizzle-orm";
import { type ChatCipher, chatCipher } from "@/server/chat/cipher";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionHash } from "@/server/execution/records";
import { type AgentInstruction, instructionFundingAsset } from "@/shared/agent-instructions";
import { type AgentSetupDraft, agentSetupDraftSchema } from "@/shared/research";
import { AgentError } from "./errors";

export function setupBindingHash(draft: AgentSetupDraft): string {
  return executionHash({ tool: draft.tool, brief: draft.brief, budget: draft.budget ?? null });
}

/** Owner transaction required. Linking retains the wallet reservation until confirmed inventory takes it over. */
export async function bindAgentSetup(
  db: AppDatabase,
  owner: string,
  agentId: string,
  setupId: string | undefined,
  expectedHash: string | undefined,
  instruction: AgentInstruction,
  injectedCipher?: ChatCipher,
): Promise<void> {
  if (!setupId || !expectedHash) {
    throw new AgentError("invalid_input", "Create and review a setup before saving this agent.");
  }
  const cipher = injectedCipher ?? chatCipher();
  const [row] = await db
    .select()
    .from(chatAgentDrafts)
    .where(and(eq(chatAgentDrafts.id, setupId), eq(chatAgentDrafts.userId, owner)))
    .for("update")
    .limit(1);
  if (!row) {
    throw new AgentError("not_found", "The reviewed setup could not be found.");
  }
  const draft = agentSetupDraftSchema.parse(
    JSON.parse(cipher.open(owner, row.id, "agent-setup", row.sealedDraft)),
  );
  if (
    draft.tool !== instruction.kind ||
    setupBindingHash(draft) !== expectedHash ||
    (draft.agentId && draft.agentId !== agentId)
  ) {
    throw new AgentError(
      "conflict",
      "The setup changed or already belongs to another agent. Review it again.",
    );
  }
  const funding = instructionFundingAsset(instruction);
  if (
    funding !== null &&
    (!draft.budget ||
      (draft.budget.assetId !== funding &&
        !(draft.budget.assetId === "native:near" && funding === "nep141:wrap.near")))
  ) {
    throw new AgentError(
      "invalid_input",
      "Allocate the strategy's spending token in its setup before creating the agent.",
    );
  }
  if (draft.budget) {
    const order =
      "amountUnits" in instruction
        ? instruction.amountUnits
        : instruction.kind === "sell_the_top"
          ? instruction.quantityUnits
          : null;
    if (order !== null && BigInt(order) > BigInt(draft.budget.units)) {
      throw new AgentError("invalid_input", "The configured order exceeds this agent's token allocation.");
    }
  }
  const linked = agentSetupDraftSchema.parse({ ...draft, agentId, reviewState: "reviewed" });
  await db
    .update(chatAgentDrafts)
    .set({ sealedDraft: cipher.seal(owner, row.id, "agent-setup", JSON.stringify(linked)) })
    .where(eq(chatAgentDrafts.id, row.id));
}

/** Called only after exact, verified venue inventory is attributed in the same owner transaction. */
export async function fulfilSetupBudget(
  db: AppDatabase,
  owner: string,
  agentId: string,
  assetId: string,
  units: string,
  injectedCipher?: ChatCipher,
): Promise<void> {
  const cipher = injectedCipher ?? chatCipher();
  const rows = await db.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.userId, owner)).limit(101);
  if (rows.length > 100) {
    throw new AgentError("not_ready", "Discard old setups before funding another agent.");
  }
  const matches = rows.flatMap((row) => {
    const draft = agentSetupDraftSchema.parse(
      JSON.parse(cipher.open(owner, row.id, "agent-setup", row.sealedDraft)),
    );
    return draft.agentId === agentId ? [{ row, draft }] : [];
  });
  if (matches.length !== 1 || !matches[0]?.draft.budget) {
    throw new AgentError("not_ready", "This agent needs one linked token allocation before funding.");
  }
  const { row, draft } = matches[0];
  const budget = draft.budget;
  if (
    !budget ||
    (budget.assetId !== assetId && !(budget.assetId === "native:near" && assetId === "nep141:wrap.near"))
  ) {
    throw new AgentError("not_ready", "The verified funding token differs from the selected budget token.");
  }
  const remaining = BigInt(budget.walletReservedUnits ?? budget.units) - BigInt(units);
  if (remaining < 0n) {
    throw new AgentError("not_ready", "This amount exceeds the remaining unfunded token allocation.");
  }
  const updated = { ...draft, budget: { ...budget, walletReservedUnits: remaining.toString() } };
  await db
    .update(chatAgentDrafts)
    .set({ sealedDraft: cipher.seal(owner, row.id, "agent-setup", JSON.stringify(updated)) })
    .where(eq(chatAgentDrafts.id, row.id));
}
