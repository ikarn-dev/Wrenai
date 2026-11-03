import "server-only";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import { agentEvents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { ExecutionError } from "../contracts";
import type { DefiPlan } from "../defi-contracts";
import { executionHash } from "../records";
import { synchronizePerpsInventory } from "./account-state";
import { perpsCashAssetId } from "./contracts";
import { readHlOpenOrders } from "./observations";

export async function ownedReturnSource(
  db: AppDatabase,
  userId: string,
  agentId: string,
  actionId?: string,
): Promise<{
  readonly agent: Awaited<ReturnType<typeof ownedAgent>>;
  readonly account: NonNullable<Awaited<ReturnType<typeof readAgentTradingAccount>>>;
}> {
  const agent = await ownedAgent(db, userId, agentId),
    account = await readAgentTradingAccount(db, userId, agentId),
    root = await activeTradingAccount(db, userId);
  if (
    agent.pack !== "perps" ||
    agent.status === "running" ||
    !account ||
    !root ||
    account.rootId !== root.id ||
    root.backupVersion !== 2 ||
    root.backupConfirmedAt === null ||
    (await killSwitchEngaged(db, userId))
  ) {
    throw new ExecutionError(
      "not_ready",
      "Pause this Perps agent and keep its backed-up authorization active before returning funds.",
    );
  }
  const [position] = await db
    .select({ id: defiPositions.id })
    .from(defiPositions)
    .where(
      and(
        eq(defiPositions.userId, userId),
        eq(defiPositions.agentId, agentId),
        gt(defiPositions.quantityUnits, 0n),
      ),
    )
    .limit(1);
  const [pending] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        isNull(executionActions.reservationReleasedAt),
        actionId ? ne(executionActions.id, actionId) : undefined,
      ),
    )
    .limit(1);
  if (position || pending) {
    throw new ExecutionError(
      "not_ready",
      "Close all positions and reconcile existing orders before returning funds.",
    );
  }
  return { agent, account };
}
export async function requireClosedReturnVenue(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<Awaited<ReturnType<typeof synchronizePerpsInventory>>> {
  const account = await readAgentTradingAccount(db, userId, agentId);
  if (!account) {
    throw new ExecutionError("not_ready", "The trading address is unavailable.");
  }
  const values = await Promise.allSettled([
    synchronizePerpsInventory(db, userId, agentId),
    readHlOpenOrders(account.perpAddress),
  ]);
  const [state, orders] = values;
  if (
    state.status !== "fulfilled" ||
    orders.status !== "fulfilled" ||
    orders.value.length > 0 ||
    state.value.assetPositions.some((row) => /[1-9]/.test(row.position.szi))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The venue must confirm that all positions and orders are closed before returning funds.",
    );
  }
  return state.value;
}
/** An explicit owner-confirmed withdrawal cannot be authorized by a model-supplied funding flag. */
export async function verifiedReturnFunding(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
  user: Pick<SessionUser, "accountId">,
  actionId?: string,
): Promise<boolean> {
  const { account } = await ownedReturnSource(db, userId, plan.agentId, actionId);
  const source = plan.cash.find((cash) => BigInt(cash.maxDebitUnits) > 0n),
    destination = plan.cash.find((cash) => cash.scope === "confidential");
  if (
    !plan.returnFunds ||
    !plan.funding ||
    plan.fundingFeeUnits !== "1000000" ||
    plan.budgetMode !== "per_agent" ||
    plan.scope !== "hyperliquid" ||
    plan.operation !== "transfer" ||
    plan.venueId !== "hyperliquid" ||
    plan.positions.length !== 0 ||
    source?.assetId !== perpsCashAssetId(account.perpAddress) ||
    (source.scope !== undefined && source.scope !== "hyperliquid") ||
    source.minCreditUnits !== "0" ||
    BigInt(source.maxDebitUnits) < 1_500_000n ||
    !destination?.assetId.startsWith("nep141:") ||
    destination.maxDebitUnits !== "0" ||
    BigInt(destination.minCreditUnits) <= 0n ||
    plan.recipient !== user.accountId
  ) {
    throw new ExecutionError(
      "not_ready",
      "Funds can return only from this agent's closed venue account to the owner's confirmed private balance.",
    );
  }
  const [confirmation] = await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.userId, userId),
        eq(agentEvents.agentId, plan.agentId),
        eq(agentEvents.kind, "perps_return_confirmed"),
        sql`${agentEvents.detailJson}::jsonb ->> 'planHash' = ${executionHash(plan)}`,
      ),
    )
    .limit(1);
  if (!confirmation) {
    throw new ExecutionError("not_ready", "Confirm this exact return preview before any funds move.");
  }
  return true;
}
