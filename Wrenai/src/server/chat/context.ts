import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { readWalletAllocations } from "@/server/agents/token-budgets";
import type { SessionUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { readWalletBalance } from "@/server/portfolio/wallet-balance";
import { WALLET_SCAN_TIMEOUT_MS, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import { budgetTokenAmount, walletAssetSchema, walletBudgetAvailability } from "@/shared/agent-budget";
import type { ChatContext } from "@/shared/chat";
import { formatUnits } from "@/shared/money";
import { WALLET_SWAP_INPUT, WALLET_SWAP_USDC } from "@/shared/wallet-swap";

const NATIVE = "native:near";

/** Reads the default user-authorized account snapshot when includeContext is true. No keys, policies or strategy text. */
export async function readChatContext(
  db: AppDatabase,
  user: SessionUser,
  options: { readonly message?: string; readonly signal?: AbortSignal } = {},
): Promise<ChatContext> {
  const timeout = AbortSignal.timeout(WALLET_SCAN_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const explicit = new Set<string>();
  for (const match of (options.message ?? "").matchAll(/\bnep141:[a-z0-9]+(?:[._-][a-z0-9]+)*/gi)) {
    const asset = walletAssetSchema.safeParse(match[0].toLowerCase());
    if (asset.success) {
      explicit.add(asset.data);
    }
  }
  const [holdings, allocations, rows] = await Promise.all([
    walletTokenHoldings(
      user.accountId,
      [NATIVE, WALLET_SWAP_USDC, WALLET_SWAP_INPUT, ...explicit],
      signal,
    ).catch(() => null),
    readWalletAllocations(db, user.id, user.accountId).catch(() => null),
    db
      .select({ name: agents.name, pack: agents.pack, status: agents.status, updatedAt: agents.updatedAt })
      .from(agents)
      .where(and(eq(agents.userId, user.id), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt))
      .limit(51),
  ]);
  const native = holdings?.tokens.find(({ assetId }) => assetId === NATIVE);
  const balance = native
    ? { kind: "balance" as const, yocto: BigInt(native.balanceUnits), readAt: native.observedAt }
    : await readWalletBalance(user.accountId, signal).catch(() => ({ kind: "unavailable" as const }));
  return {
    readAt: Date.now(),
    accountId: user.accountId,
    wallet:
      balance.kind === "balance"
        ? {
            kind: "balance",
            near: formatUnits(balance.yocto, { decimals: 24, fractionDigits: 24 }),
            readAt: balance.readAt,
          }
        : balance,
    walletHoldings: {
      coverage: holdings === null ? "unavailable" : holdings.complete ? "complete" : "partial",
      tokens:
        holdings?.tokens.map((token) => ({
          assetId: token.assetId,
          symbol: token.symbol,
          balance: budgetTokenAmount(token.balanceUnits, token.decimals),
          available:
            allocations === null
              ? null
              : budgetTokenAmount(
                  walletBudgetAvailability(token, allocations(token.assetId)).availableUnits,
                  token.decimals,
                ),
        })) ?? [],
    },
    agents: rows.slice(0, 50),
    agentsTruncated: rows.length > 50,
  };
}
