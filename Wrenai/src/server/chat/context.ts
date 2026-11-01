import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SessionUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { readWalletBalance } from "@/server/portfolio/wallet-balance";
import type { ChatContext } from "@/shared/chat";
import { formatUnits } from "@/shared/money";

/** Reads the default user-authorized account snapshot when includeContext is true. No keys, policies or strategy text. */
export async function readChatContext(db: AppDatabase, user: SessionUser): Promise<ChatContext> {
  const [balance, rows] = await Promise.all([
    readWalletBalance(user.accountId),
    db
      .select({ name: agents.name, pack: agents.pack, status: agents.status, updatedAt: agents.updatedAt })
      .from(agents)
      .where(and(eq(agents.userId, user.id), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt))
      .limit(51),
  ]);
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
    agents: rows.slice(0, 50),
    agentsTruncated: rows.length > 50,
  };
}
