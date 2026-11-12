import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { type TestnetIntent, type TestnetRule, testnetAsset } from "@/shared/testnet";
import { nextSlotAt } from "@/shared/testnet-schedule";
import { parseTokenAmount } from "@/shared/token-units";
import { openRule, priceTrigger, slotId, stopTestnetAgent, swapQuote, type TestnetAgent } from "./agents";
import { TestnetError } from "./config";
import type { TestnetDatabase } from "./database";
import { advanceTestnetOrder } from "./execution";
import { confirmTestnetOrder, quoteTestnetOrder } from "./orders";
import { ownedBalance, poolTransaction, type TestnetOwner } from "./pool";
import { tnAgents, tnOrders, tnOwners } from "./schema";

// Cadences (Docs/cloud-architecture.md → approved five-second reconciliation and market checks, 60 s slow checks).
/** An order in flight is checked this often until it settles. */
export const SETTLE_POLL_MS = 5000;
/** Dip and profit rules watch the Tidepool price this often. */
const PRICE_POLL_MS = 5000;
/** The longest single wait; a later slot is reached by waiting again. */
const MAX_WAIT_MS = 60_000;
/** A provider outage retries this soon, so a DCA slot is at most this late. */
const OUTAGE_RETRY_MS = 10_000;
const UNSETTLED = ["queued", "prepared", "submitted"] as const;

const runningSlot = (agent: TestnetAgent) =>
  and(eq(tnAgents.id, agent.id), eq(tnAgents.slot, agent.slot), eq(tnAgents.state, "running"));

/** Price rules need a fresh quote to decide; DCA, spot and payments place their order at the slot without one. */
function needsPrice(rule: TestnetRule): boolean {
  return rule.kind === "dip" || rule.kind === "profit";
}

/**
 * A provider outage or a lost race leaves the agent running and retries soon with its reason shown. An order quoted
 * for this slot but never confirmed holds no funds; moving to the next slot gets a fresh quote next time. The slot's
 * due time is kept, so the retry doesn't push later slots back.
 */
async function deferTick(db: TestnetDatabase, agent: TestnetAgent, reason: string): Promise<number> {
  const [order] = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.ownerId, agent.ownerId), eq(tnOrders.requestId, slotId(agent.id, agent.slot))));
  await db
    .update(tnAgents)
    .set({ reason, ...(order && order.confirmedAt === null ? { slot: agent.slot + 1 } : {}) })
    .where(runningSlot(agent));
  return OUTAGE_RETRY_MS;
}

function orderIntent(rule: TestnetRule): TestnetIntent {
  return rule.kind === "payments"
    ? {
        kind: "payment",
        assetId: rule.assetId,
        amount: rule.amount,
        recipient: rule.recipient ?? "",
        location: rule.location ?? "wallet",
      }
    : {
        kind: "swap",
        assetId: rule.assetId,
        outputAssetId: rule.outputAssetId ?? "",
        amount: rule.amount,
        slippageBps: 50,
        location: rule.location ?? "wallet",
        outputLocation: rule.outputLocation ?? rule.location ?? "wallet",
      };
}

/** Quotes, confirms and submits one slot's order. Returns the wait before the next tick. */
async function placeOrder(
  db: TestnetDatabase,
  owner: TestnetOwner,
  agent: TestnetAgent,
  rule: TestnetRule,
  amount: bigint,
): Promise<number> {
  if (needsPrice(rule)) {
    const quote = await swapQuote(rule, amount);
    if (rule.kind === "dip" && agent.reference === null) {
      // Deployed while pricing was down: this first price is the activation reference the dip is measured from.
      await db
        .update(tnAgents)
        .set({ reference: quote.quote.amountOut, nextAt: Date.now() + PRICE_POLL_MS, reason: null })
        .where(runningSlot(agent));
      return PRICE_POLL_MS;
    }
    if (
      !priceTrigger(rule, BigInt(agent.reference ?? quote.quote.amountOut), BigInt(quote.quote.amountOut))
    ) {
      await db
        .update(tnAgents)
        .set({ nextAt: Date.now() + PRICE_POLL_MS, reason: null })
        .where(runningSlot(agent));
      return PRICE_POLL_MS;
    }
  }
  const order = await quoteTestnetOrder(db, owner, slotId(agent.id, agent.slot), orderIntent(rule), agent.id);
  await poolTransaction(db, async (tx) => {
    const [fresh] = await tx.select().from(tnAgents).where(eq(tnAgents.id, agent.id));
    if (fresh?.state !== "running" || fresh.slot !== agent.slot) {
      throw new TestnetError("conflict", "This agent changed before execution.");
    }
  });
  await confirmTestnetOrder(db, owner, order.id);
  await db
    .update(tnAgents)
    .set({
      slot: agent.slot + 1,
      nextAt: nextSlotAt(agent.nextAt, rule.intervalSeconds * 1000, Date.now()),
      reason: null,
      ...(rule.kind === "dca" ? {} : { state: "completed" as const }),
    })
    .where(runningSlot(agent));
  await advanceTestnetOrder(db, order.id);
  return SETTLE_POLL_MS;
}

/** Advances every unsettled order once and returns how many are still unsettled afterwards. */
async function settleOrders(
  db: TestnetDatabase,
  ownerId: string,
  agentId: string,
): Promise<number | "outage"> {
  const unsettled = and(
    eq(tnOrders.ownerId, ownerId),
    eq(tnOrders.bucket, agentId),
    inArray(tnOrders.state, UNSETTLED),
  );
  const pending = await db.select({ id: tnOrders.id }).from(tnOrders).where(unsettled);
  try {
    for (const order of pending) {
      await advanceTestnetOrder(db, order.id);
    }
  } catch (error) {
    // Unsettled orders keep their reservations; an unreachable RPC only delays their next check.
    if (error instanceof TestnetError && error.code === "unavailable") {
      return "outage";
    }
    throw error;
  }
  return pending.length === 0
    ? 0
    : (await db.select({ id: tnOrders.id }).from(tnOrders).where(unsettled)).length;
}

function endReason(agent: TestnetAgent, owner: TestnetOwner, now: number): string | null {
  if (owner.expiresAt <= now) {
    return "Your guest session ended. Its funds wait in Claims.";
  }
  return agent.expiresAt <= now ? "Its end time passed. Its funds wait in Claims." : null;
}

/**
 * One bounded check of a testnet agent. Returns the milliseconds until its next check, or null when its workflow can
 * end: stopped with nothing in flight. Waits end at the agent's own due time, so a 60 second DCA runs every 60
 * seconds instead of every poll after it.
 */
export async function tickTestnetAgent(db: TestnetDatabase, id: string): Promise<number | null> {
  const [agent] = await db.select().from(tnAgents).where(eq(tnAgents.id, id));
  const [owner] = agent ? await db.select().from(tnOwners).where(eq(tnOwners.id, agent.ownerId)) : [];
  if (!agent || !owner) {
    return null;
  }
  const [held] = await db
    .select({ id: tnOrders.id })
    .from(tnOrders)
    .where(and(eq(tnOrders.ownerId, owner.id), eq(tnOrders.bucket, id), eq(tnOrders.state, "needs_review")))
    .limit(1);
  if (held) {
    await db
      .update(tnAgents)
      .set({ state: "blocked", reason: "An order needs reconciliation. Funds remain reserved." })
      .where(and(eq(tnAgents.id, id), eq(tnAgents.state, "running")));
    return null;
  }
  const unsettled = await settleOrders(db, owner.id, id);
  if (unsettled === "outage") {
    return SETTLE_POLL_MS;
  }
  if (agent.state !== "running") {
    return unsettled > 0 ? SETTLE_POLL_MS : null;
  }
  const now = Date.now(),
    ended = endReason(agent, owner, now);
  if (ended) {
    await stopTestnetAgent(db, owner.id, id, ended);
    return unsettled > 0 ? SETTLE_POLL_MS : null;
  }
  if (unsettled > 0) {
    return SETTLE_POLL_MS;
  }
  if (agent.nextAt > now) {
    return Math.min(agent.nextAt - now, MAX_WAIT_MS, agent.expiresAt - now);
  }
  const rule = openRule(agent),
    amount = parseTokenAmount(rule.amount, testnetAsset(rule.assetId).decimals),
    balance = await ownedBalance(db, owner.id, rule.assetId, id, rule.location ?? "wallet");
  if (BigInt(balance.units) - BigInt(balance.held) < amount) {
    await stopTestnetAgent(db, owner.id, id, "Budget used. Its remaining funds wait in Claims.");
    return null;
  }
  try {
    return await placeOrder(db, owner, agent, rule, amount);
  } catch (error) {
    if (!(error instanceof TestnetError)) {
      throw error;
    }
    // A cap or invalid rule won't clear by waiting: stop and say why. Outages and races retry soon.
    if (error.code === "limit" || error.code === "invalid_input") {
      // Keep polling: the next tick settles any order already confirmed, then ends.
      await stopTestnetAgent(db, owner.id, id, `Stopped: ${error.message}`);
      return SETTLE_POLL_MS;
    }
    return deferTick(db, agent, error.message);
  }
}
