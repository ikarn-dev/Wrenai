import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { type ChatCipher, chatCipher } from "@/server/chat/cipher";
import { ChatError } from "@/server/chat/errors";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { positionLots } from "@/server/db/position-schema";
import { users } from "@/server/db/schema";
import { nativeWalletHolds } from "@/server/funding/native-records";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import {
  type AgentBudgetInput,
  type AgentTokenBudget,
  checkedWalletBudget,
  type WalletBudgetView,
  type WalletHolding,
  walletBudgetAvailability,
} from "@/shared/agent-budget";
import { agentSetupDraftSchema } from "@/shared/research";
import { parseTokenAmount } from "@/shared/token-units";

export interface PreparedAgentBudget {
  readonly accountId: string;
  readonly input: AgentBudgetInput;
  readonly holding: WalletHolding;
}

async function ownerAccount(db: AppDatabase, userId: string): Promise<string> {
  const [user] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new ChatError("signed_out", "Sign in again to allocate a budget.");
  }
  return user.accountId;
}

/** Called before the owner transaction: external I/O must never hold the financial lock. */
export async function prepareAgentBudget(
  db: AppDatabase,
  userId: string,
  input: AgentBudgetInput,
): Promise<PreparedAgentBudget> {
  const accountId = await ownerAccount(db, userId);
  return { accountId, input, holding: await walletTokenHolding(accountId, input.assetId) };
}

export async function reservedWalletBudgets(
  db: AppDatabase,
  owner: string,
  cipher: ChatCipher = chatCipher(),
  excludeId?: string,
): Promise<readonly AgentTokenBudget[]> {
  const rows = await db.select().from(chatAgentDrafts).where(eq(chatAgentDrafts.userId, owner)).limit(1001);
  if (rows.length > 1000) {
    throw new ChatError("conflict", "Discard old setups before allocating another budget.");
  }
  return rows
    .filter((row) => row.id !== excludeId)
    .flatMap((row) => {
      try {
        const draft = agentSetupDraftSchema.parse(
          JSON.parse(cipher.open(owner, row.id, "agent-setup", row.sealedDraft)),
        );
        return draft.budget ? [draft.budget] : [];
      } catch {
        throw new ChatError(
          "unavailable",
          "Saved agent allocations could not be verified. No new funds were reserved.",
        );
      }
    });
}

/** Owner lock required: drafts and funded lots use exact units, never a price-derived token balance. */
export async function reserveSetupBudget(
  db: AppDatabase,
  owner: string,
  id: string,
  prepared: PreparedAgentBudget,
  cipher: ChatCipher,
  previous?: AgentTokenBudget,
): Promise<AgentTokenBudget> {
  if ((await ownerAccount(db, owner)) !== prepared.accountId) {
    throw new ChatError("conflict", "The wallet changed. Refresh before allocating funds.");
  }
  const budgets = await reservedWalletBudgets(db, owner, cipher, id);
  const allocated =
    (await nativeWalletHolds(db, owner, prepared.input.assetId)) +
    budgets.reduce(
      (sum, budget) =>
        sum +
        (budget.accountId === prepared.accountId && budget.assetId === prepared.input.assetId
          ? BigInt(budget.walletReservedUnits ?? budget.units)
          : 0n),
      0n,
    );
  try {
    const oldUnits =
      previous?.accountId === prepared.accountId &&
      previous.assetId === prepared.input.assetId &&
      previous.decimals === prepared.holding.decimals
        ? BigInt(previous.units)
        : 0n;
    return checkedWalletBudget(
      prepared.accountId,
      prepared.input,
      prepared.holding,
      allocated,
      Date.now(),
      oldUnits,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ChatError("invalid_input", error.message);
    }
    throw error;
  }
}

export function sameBudgetInput(
  stored: AgentTokenBudget | undefined,
  requested: AgentBudgetInput | null | undefined,
): boolean {
  if (!stored || !requested) {
    return stored === undefined && !requested;
  }
  if (stored.assetId !== requested.assetId) {
    return false;
  }
  try {
    return BigInt(stored.units) === parseTokenAmount(requested.amount, stored.decimals);
  } catch {
    return false;
  }
}

export async function readWalletBudgets(
  db: AppDatabase,
  owner: string,
  excludeId?: string,
  extraAsset?: string,
  cipher: ChatCipher = chatCipher(),
): Promise<WalletBudgetView> {
  const accountId = await ownerAccount(db, owner);
  const budgets = await reservedWalletBudgets(db, owner, cipher, excludeId);
  const extras = [
    ...new Set([
      ...(extraAsset ? [extraAsset] : []),
      ...budgets.filter((budget) => budget.accountId === accountId).map((budget) => budget.assetId),
    ]),
  ];
  const [wallet, funded] = await Promise.all([
    walletTokenHoldings(accountId, extras),
    db
      .select({
        scope: positionLots.scope,
        assetId: positionLots.assetId,
        units: sql<string>`sum(${positionLots.remainingUnits})::text`,
      })
      .from(positionLots)
      .where(and(eq(positionLots.userId, owner), gt(positionLots.remainingUnits, 0n)))
      .groupBy(positionLots.scope, positionLots.assetId)
      .limit(500),
  ]);
  const nativeHolds = new Map(
    await Promise.all(
      wallet.tokens.map(
        async (holding) => [holding.assetId, await nativeWalletHolds(db, owner, holding.assetId)] as const,
      ),
    ),
  );
  return {
    accountId,
    note: wallet.note,
    funded,
    tokens: wallet.tokens.map((holding) =>
      walletBudgetAvailability(
        holding,
        (nativeHolds.get(holding.assetId) ?? 0n) +
          budgets.reduce(
            (sum, budget) =>
              sum +
              (budget.accountId === accountId && budget.assetId === holding.assetId
                ? BigInt(budget.walletReservedUnits ?? budget.units)
                : 0n),
            0n,
          ),
      ),
    ),
  };
}
