import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { chatCipher } from "@/server/chat/cipher";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { agentSetupDraftSchema } from "@/shared/research";
import { type WalletFundingView, walletFundingSnapshotSchema } from "@/shared/wallet-funding";
import { activeNativeFunding } from "./native-records";

export async function ownedWalletFunding(
  db: AppDatabase,
  owner: string,
  id: string,
): Promise<typeof walletFundings.$inferSelect> {
  z.uuid().parse(id);
  const [row] = await db
    .select()
    .from(walletFundings)
    .where(and(eq(walletFundings.id, id), eq(walletFundings.userId, owner)))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "The funding request could not be found.");
  }
  return row;
}
export function walletFundingView(row: typeof walletFundings.$inferSelect): WalletFundingView {
  return {
    id: row.id,
    state: row.state,
    snapshot: walletFundingSnapshotSchema.parse(JSON.parse(row.snapshotJson)),
    transactionHash: row.transactionHash,
    actionId: row.actionId,
    expiresAt: row.expiresAt,
  };
}
export async function linkedAgentBudget(
  db: AppDatabase,
  owner: string,
  agentId: string,
): Promise<z.infer<typeof agentSetupDraftSchema>> {
  const cipher = chatCipher(),
    rows = await db.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.userId, owner)).limit(101);
  if (rows.length > 100) {
    throw new ExecutionError("not_ready", "Discard unused setups before funding another agent.");
  }
  const drafts = rows
    .map((row) =>
      agentSetupDraftSchema.parse(JSON.parse(cipher.open(owner, row.id, "agent-setup", row.sealedDraft))),
    )
    .filter((draft) => draft.agentId === agentId);
  if (drafts.length !== 1 || !drafts[0]) {
    throw new ExecutionError("not_ready", "This agent needs one reviewed token budget.");
  }
  return drafts[0];
}
export async function assertNoWalletFunding(db: AppDatabase, owner: string, agentId: string): Promise<void> {
  const [row] = await db
    .select({ id: walletFundings.id })
    .from(walletFundings)
    .where(
      and(
        eq(walletFundings.userId, owner),
        eq(walletFundings.agentId, agentId),
        ne(walletFundings.state, "complete"),
      ),
    )
    .limit(1);
  const native = await activeNativeFunding(db, owner);
  if (row || native?.snapshot.agentId === agentId) {
    throw new ExecutionError(
      "not_ready",
      "Finish or recover this agent’s funding before changing its strategy or allocations.",
    );
  }
}
