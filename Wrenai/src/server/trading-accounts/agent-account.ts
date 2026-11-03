import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { HDNodeWallet } from "ethers";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { agentTradingAccounts } from "@/server/db/trading-account-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";
import { derivePerpsWallet } from "@/shared/perps-derivation";
import { PERPS_DERIVATION } from "@/shared/trading-recovery";
import { activeTradingAccount, tradingAccountSigningKeys } from "./vault";

export async function readAgentTradingAccount(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<typeof agentTradingAccounts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(agentTradingAccounts)
    .where(and(eq(agentTradingAccounts.userId, userId), eq(agentTradingAccounts.agentId, agentId)))
    .limit(1);
  return row ?? null;
}
/** Only first activation/funding can derive an address. Agent creation never sets up keys. */
export async function ensureAgentTradingAccount(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<typeof agentTradingAccounts.$inferSelect> {
  await ownedAgent(db, userId, agentId);
  const root = await activeTradingAccount(db, userId);
  if (!root || root.backupVersion < 2 || root.backupConfirmedAt === null) {
    throw new ExecutionError(
      "not_ready",
      "Download and confirm the updated recovery backup before Perps funding.",
    );
  }
  const keys = await tradingAccountSigningKeys(db, userId, root.id);
  return userTransaction(db, userId, async (tx) => {
    const agent = await ownedAgent(tx, userId, agentId),
      current = await activeTradingAccount(tx, userId);
    if (
      agent.pack !== "perps" ||
      current?.id !== root.id ||
      current.backupVersion < 2 ||
      current.backupConfirmedAt === null
    ) {
      throw new ExecutionError("not_ready", "The Perps account or recovery permission changed.");
    }
    const existing = await readAgentTradingAccount(tx, userId, agentId);
    if (existing) {
      if (existing.rootId !== root.id) {
        throw new ExecutionError(
          "not_ready",
          "Recover or close this agent's previous trading account before changing the recovery root.",
        );
      }
      return existing;
    }
    const [last] = await tx
      .select({ index: agentTradingAccounts.derivationIndex })
      .from(agentTradingAccounts)
      .where(eq(agentTradingAccounts.rootId, root.id))
      .orderBy(desc(agentTradingAccounts.derivationIndex))
      .limit(1);
    const index = (last?.index ?? -1) + 1;
    if (index >= PERPS_DERIVATION.addressCount) {
      throw new ExecutionError("limit", "This recovery root's documented address range is exhausted.");
    }
    const wallet = derivePerpsWallet(keys.perps.privateKey, index);
    const [saved] = await tx
      .insert(agentTradingAccounts)
      .values({
        userId,
        agentId,
        rootId: root.id,
        derivationIndex: index,
        perpAddress: wallet.address,
        createdAt: await databaseTime(tx),
      })
      .returning();
    if (!saved) {
      throw new ExecutionError("not_ready", "The isolated agent address could not be recorded.");
    }
    return saved;
  });
}
export async function agentPerpsSigningWallet(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<HDNodeWallet> {
  const account = await readAgentTradingAccount(db, userId, agentId),
    root = await activeTradingAccount(db, userId);
  if (!account || !root || account.rootId !== root.id || root.backupVersion < 2) {
    throw new ExecutionError(
      "not_ready",
      "This agent's backed-up trading account is unavailable or revoked.",
    );
  }
  const keys = await tradingAccountSigningKeys(db, userId, root.id),
    derived = derivePerpsWallet(keys.perps.privateKey, account.derivationIndex);
  if (derived.address !== account.perpAddress) {
    throw new ExecutionError("conflict", "The derived trading identity does not match its funded address.");
  }
  return derived;
}
