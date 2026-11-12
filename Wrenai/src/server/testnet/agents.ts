import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { type TestnetRule, testnetAsset } from "@/shared/testnet";
import { parseTokenAmount } from "@/shared/token-units";
import { openAgentRecord, openReview, sealAgentRecord } from "./agent-record";
import { TestnetError, testnetEnv } from "./config";
import type { TestnetDatabase } from "./database";
import { changeBalance, poolTransaction, type TestnetOwner } from "./pool";
import { testnetQuote } from "./provider";
import { tnAgents, tnBalances } from "./schema";
export type TestnetAgent = typeof tnAgents.$inferSelect;
/** The order request ID for one agent slot, so a retried slot reuses its quote instead of opening a second order. */
export function slotId(agent: string, slot: number): string {
  const hash = createHash("sha256").update(`${agent}:${slot}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function openRule(agent: TestnetAgent): TestnetRule {
  return openAgentRecord(agent.ownerId, agent.id, agent.sealedRule).rule;
}
function checkRule(owner: TestnetOwner, rule: TestnetRule): void {
  if (rule.expiresAt <= Date.now() || rule.expiresAt > owner.expiresAt) {
    throw new TestnetError("invalid_input", "End this strategy before your guest session expires.");
  }
  const asset = testnetAsset(rule.assetId),
    budget = parseTokenAmount(rule.budget, asset.decimals),
    amount = parseTokenAmount(rule.amount, asset.decimals);
  const cap = testnetEnv().allowances.find((a) => a.assetId === rule.assetId)?.cap;
  if (cap === undefined || amount > cap) {
    throw new TestnetError("limit", "The amount exceeds the testnet per-action cap.");
  }
  if (amount > budget) {
    throw new TestnetError("limit", "The order amount exceeds this agent's budget.");
  }
  if (rule.kind === "payments") {
    if (!rule.recipient) {
      throw new TestnetError("invalid_input", "Choose the exact testnet recipient.");
    }
  } else if (
    !rule.outputAssetId ||
    rule.assetId === rule.outputAssetId ||
    !asset.contract ||
    !testnetAsset(rule.outputAssetId).contract
  ) {
    throw new TestnetError(
      "invalid_input",
      "Select two supported Tidepool test tokens. Native NEAR is not a Tidepool swap token.",
    );
  }
  if (rule.kind === "profit" && !rule.costBasis) {
    throw new TestnetError(
      "invalid_input",
      "Enter the acquisition cost of each sell amount in the receive token.",
    );
  }
}
export function swapQuote(rule: TestnetRule, amount: bigint): ReturnType<typeof testnetQuote> {
  return testnetQuote(
    rule.assetId,
    rule.outputAssetId ?? "",
    amount.toString(),
    testnetEnv().TESTNET_POOL_ACCOUNT_ID,
    50,
    true,
    rule.location ?? "wallet",
    rule.outputLocation ?? rule.location ?? "wallet",
  );
}
/**
 * The output one order would get now: the reference a dip is measured from. Only dips use it, so DCA, spot, profit
 * and payments deploy without a price read. When Tidepool pricing is down it is null, and the agent's first price
 * check sets it instead, so a pricing outage never blocks deploying.
 */
export async function referenceOutput(rule: TestnetRule): Promise<string | null> {
  if (rule.kind !== "dip" || !rule.outputAssetId) {
    return null;
  }
  try {
    const quote = await swapQuote(rule, parseTokenAmount(rule.amount, testnetAsset(rule.assetId).decimals));
    return quote.quote.amountOut;
  } catch (error) {
    if (error instanceof TestnetError && error.code === "unavailable") {
      return null;
    }
    throw error;
  }
}
export async function createTestnetAgent(
  db: TestnetDatabase,
  owner: TestnetOwner,
  requestId: string,
  rule: TestnetRule,
  review?: string,
): Promise<string> {
  if (owner.kind !== "guest") {
    throw new TestnetError(
      "invalid_input",
      "Autonomous testnet agents currently use the capped guest pool. Connected wallets can make manual transfers and swaps.",
    );
  }
  checkRule(owner, rule);
  const budget = parseTokenAmount(rule.budget, testnetAsset(rule.assetId).decimals);
  const id = randomUUID(),
    reference = await referenceOutput(rule),
    verification = openReview(owner.id, rule, review);
  return poolTransaction(db, async (tx) => {
    const [prior] = await tx
      .select()
      .from(tnAgents)
      .where(and(eq(tnAgents.ownerId, owner.id), eq(tnAgents.requestId, requestId)));
    if (prior) {
      if (JSON.stringify(openRule(prior)) !== JSON.stringify(rule)) {
        throw new TestnetError("conflict", "This setup ID belongs to another strategy.");
      }
      return prior.id;
    }
    // Stopped agents still count until deleted, so Delete is what frees a slot. Agents whose end time passed can
    // never run again, so they don't hold a slot in a renewed allowance.
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tnAgents)
      .where(
        and(
          eq(tnAgents.ownerId, owner.id),
          ne(tnAgents.state, "deleted"),
          gt(tnAgents.expiresAt, Date.now()),
        ),
      );
    if (count >= testnetEnv().TESTNET_MAX_AGENTS_PER_GUEST) {
      throw new TestnetError("limit", "Your agent limit is reached. Delete an agent you no longer need.");
    }
    await changeBalance(tx, owner.id, rule.assetId, -budget, 0n, "manual", rule.location ?? "wallet");
    await changeBalance(tx, owner.id, rule.assetId, budget, 0n, id, rule.location ?? "wallet");
    await tx.insert(tnAgents).values({
      id,
      ownerId: owner.id,
      requestId,
      name: rule.name,
      kind: rule.kind,
      state: "running",
      sealedRule: sealAgentRecord(owner.id, id, rule, verification),
      nextAt: Date.now(),
      expiresAt: rule.expiresAt,
      reference,
      createdAt: Date.now(),
    });
    return id;
  });
}
/** Owner-scoped agent row inside a pool transaction. */
export async function ownedAgent(tx: TestnetDatabase, owner: string, id: string): Promise<TestnetAgent> {
  const [agent] = await tx
    .select()
    .from(tnAgents)
    .where(and(eq(tnAgents.id, id), eq(tnAgents.ownerId, owner)));
  if (!agent) {
    throw new TestnetError("unauthorized", "This agent is not available.");
  }
  return agent;
}
/** Stops new orders. Funds stay with the agent, as on mainnet: unsettled orders keep theirs, the rest waits in Claims. */
export async function stopTestnetAgent(
  db: TestnetDatabase,
  owner: string,
  id: string,
  reason = "Stopped. Its funds wait in Claims.",
): Promise<void> {
  await poolTransaction(db, async (tx) => {
    const agent = await ownedAgent(tx, owner, id);
    if (agent.state === "deleted") {
      return;
    }
    await tx.update(tnAgents).set({ state: "stopped", reason }).where(eq(tnAgents.id, id));
  });
}
/** Moves an agent's free units back to the owner's test balance; units held by unsettled orders stay. */
export async function releaseAgent(db: TestnetDatabase, agent: TestnetAgent): Promise<bigint> {
  const rows = await db
    .select()
    .from(tnBalances)
    .where(and(eq(tnBalances.ownerId, agent.ownerId), eq(tnBalances.bucket, agent.id)));
  let released = 0n;
  for (const row of rows) {
    const free = BigInt(row.units) - BigInt(row.held);
    if (free > 0n) {
      await changeBalance(db, agent.ownerId, row.assetId, -free, 0n, agent.id, row.location);
      await changeBalance(db, agent.ownerId, row.assetId, free, 0n, "manual", row.location);
      released += free;
    }
  }
  return released;
}
export function priceTrigger(rule: TestnetRule, reference: bigint, output: bigint): boolean {
  if (rule.kind === "dip") {
    return output * BigInt(10000 - rule.thresholdBps) >= reference * 10000n;
  }
  if (rule.kind === "profit") {
    if (!rule.outputAssetId || !rule.costBasis) {
      return false;
    }
    const basis = parseTokenAmount(rule.costBasis, testnetAsset(rule.outputAssetId).decimals);
    return output * 10000n >= basis * BigInt(10000 + rule.thresholdBps);
  }
  return true;
}
