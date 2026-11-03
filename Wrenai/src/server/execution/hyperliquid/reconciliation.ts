import "server-only";
import { eq } from "drizzle-orm";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { databaseTime, executionEvent, ownedLedgerAction, requireLease } from "../records";
import { readHlAccount, synchronizePerpsInventory } from "./account-state";
import { readPerpsCheckpoint } from "./checkpoint";
import { accountPerpsFills } from "./fill-accounting";
import { readHlRequest } from "./journal";
import { corroboratePerpsLiquidations } from "./liquidation";
import { readHlFills, readHlOpenOrders, readHlTransfers } from "./observations";
import { perpsOrderIdentities } from "./order-identities";
import { readHlOrder } from "./order-record";
import { maintainPerpsProtection } from "./protection";
import { settlePerpsFills, settlePerpsNoEffect } from "./settlement";

export async function reconcilePerpsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  repairProtection = true,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await synchronizePerpsInventory(db, userId, action.agentId);
    }
    return "settled";
  }
  requireLease(action, token, await databaseTime(db));
  if (!["submitting", "submitted", "unknown"].includes(action.status)) {
    return "pending";
  }
  const saved = await readHlOrder(db, action),
    request = await readHlRequest(db, action, "trade"),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (!request) {
    throw new ExecutionError("conflict", "The venue order has no pre-submission journal.");
  }
  const checkpoint = saved.role === "exit" ? await readPerpsCheckpoint(db, userId, action.agentId) : null;
  const identity = await perpsOrderIdentities(db, action, saved, checkpoint ?? undefined),
    observed = await readHlAccount(saved.address);
  if (observed.time < request.nonce || observed.time <= saved.account.time) {
    return "pending";
  }
  const fills = await readHlFills(saved.address, saved.account.time + 1, observed.time);
  const liquidations = await readHlTransfers(saved.address, saved.account.time + 1, observed.time);
  const identified = corroboratePerpsLiquidations(saved, fills, liquidations, identity.known);
  const open = await readHlOpenOrders(saved.address),
    openIds = new Set(open.map((order) => order.oid));
  if (open.some((order) => !identity.known.has(order.oid))) {
    throw new ExecutionError("not_ready", "An unmanaged order prevents complete venue reconciliation.");
  }
  const result = accountPerpsFills(
    saved,
    observed,
    fills,
    identified.known,
    plan.providerFeeBps,
    identified.forced,
  );
  if (!result) {
    return "pending";
  }
  if (fills.length === 0) {
    const currentCloids = new Set(
      saved.action.type === "order" ? saved.action.orders.map((order) => order.c) : [],
    );
    if (
      (!identity.parentTerminal && !identity.parentUnknown) ||
      observed.time <= request.expiresAfter ||
      open.some((order) => currentCloids.has(identity.known.get(order.oid)?.c)) ||
      result.quantity !== BigInt(saved.beforeExposureUnits) ||
      result.cashAfter !== BigInt(saved.beforeCashUnits)
    ) {
      return "pending";
    }
    await settlePerpsNoEffect(db, action, token, {
      requestHash: plan.payloadHash,
      accountTime: observed.time,
      cash: result.cashAfter.toString(),
      quantity: result.quantity.toString(),
      parentUnknown: identity.parentUnknown,
    });
  } else {
    if (!identity.parentTerminal || result.risk <= 0n) {
      return "pending";
    }
    const agent = await ownedAgent(db, userId, action.agentId);
    if (
      saved.role === "entry" &&
      result.quantity > 0n &&
      repairProtection &&
      agent.status === "running" &&
      !(await killSwitchEngaged(db, userId))
    ) {
      try {
        const protectedPosition = await maintainPerpsProtection(db, action, saved, result.quantity);
        if (!protectedPosition.protected) {
          return "pending";
        }
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }
        // Revocation or a provider outage must not prevent recording already executed financial facts.
        await userTransaction(db, userId, async (tx) => {
          await executionEvent(tx, action, "hl_protection_unconfirmed", await databaseTime(tx), {
            code: error.code,
          });
          await tx
            .update(agents)
            .set({
              status: "error",
              reason:
                "The Perps position is open but native protection could not be confirmed. Reconcile it and check the trading address before restarting.",
              updatedAt: await databaseTime(tx),
            })
            .where(eq(agents.id, action.agentId));
        });
      }
    }
    if (saved.role === "exit" && result.quantity >= BigInt(saved.beforeExposureUnits)) {
      throw new ExecutionError("conflict", "The filled exit did not reduce its owned position.");
    }
    await settlePerpsFills(
      db,
      action,
      token,
      saved,
      result,
      observed,
      fills,
      openIds,
      identified.known,
      checkpoint ?? undefined,
    );
  }
  await synchronizePerpsInventory(db, userId, action.agentId);
  return "settled";
}
