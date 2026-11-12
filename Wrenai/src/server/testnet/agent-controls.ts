import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { testnetAsset, tokenText } from "@/shared/testnet";
import { parseTokenAmount } from "@/shared/token-units";
import { openRule, ownedAgent, referenceOutput, releaseAgent } from "./agents";
import { TestnetError } from "./config";
import type { TestnetDatabase } from "./database";
import { changeBalance, ownedBalance, poolTransaction, type TestnetOwner } from "./pool";
import { tnAgents, tnOrders } from "./schema";

/** Deletes an agent like mainnet: it stops and leaves the list, and everything it holds waits in Claims. */
export async function deleteTestnetAgent(db: TestnetDatabase, owner: string, id: string): Promise<void> {
  await poolTransaction(db, async (tx) => {
    const agent = await ownedAgent(tx, owner, id);
    if (agent.state !== "deleted") {
      await tx
        .update(tnAgents)
        .set({ state: "deleted", reason: "Deleted. Its funds wait in Claims." })
        .where(eq(tnAgents.id, id));
    }
  });
}

/**
 * Returns an agent's free units to the guest's test balance. A running agent stops first, so it can't spend what
 * is being claimed. Units held by unsettled orders stay with the agent until those orders settle.
 */
export async function claimTestnetAgent(db: TestnetDatabase, owner: string, id: string): Promise<void> {
  await poolTransaction(db, async (tx) => {
    const agent = await ownedAgent(tx, owner, id);
    if (agent.state === "running") {
      await tx
        .update(tnAgents)
        .set({ state: "stopped", reason: "Stopped to claim its funds." })
        .where(eq(tnAgents.id, id));
    }
    if ((await releaseAgent(tx, agent)) === 0n) {
      throw new TestnetError(
        "invalid_input",
        "Nothing to claim yet. Funds held by unsettled orders return when those orders settle.",
      );
    }
  });
}

function restartBlock(state: string): string | null {
  switch (state) {
    case "stopped":
    case "completed":
      return null;
    case "running":
      return "This agent is already running.";
    case "blocked":
      return "An order needs review before this agent can restart.";
    default:
      return "This agent is deleted. Create a new one.";
  }
}

/**
 * Runs a stopped or completed agent again. It uses the funds it still holds; when those can't cover one order,
 * it reserves its full budget from the guest's test balance again. Dips measure from a fresh reference price.
 */
export async function restartTestnetAgent(
  db: TestnetDatabase,
  owner: TestnetOwner,
  id: string,
): Promise<void> {
  if (owner.kind !== "guest") {
    throw new TestnetError("invalid_input", "Autonomous testnet agents use the capped guest pool.");
  }
  const agent = await ownedAgent(db, owner.id, id),
    rule = openRule(agent);
  if (rule.expiresAt <= Date.now() || owner.expiresAt <= Date.now()) {
    throw new TestnetError("invalid_input", "This strategy's end time has passed. Create a new agent.");
  }
  const blocked = restartBlock(agent.state);
  if (blocked) {
    throw new TestnetError("conflict", blocked);
  }
  const reference = await referenceOutput(rule);
  await poolTransaction(db, async (tx) => {
    const fresh = await ownedAgent(tx, owner.id, id);
    if (fresh.state !== agent.state || fresh.slot !== agent.slot) {
      throw new TestnetError("conflict", "This agent changed. Refresh and try again.");
    }
    const unsettled = await tx
      .select({ id: tnOrders.id })
      .from(tnOrders)
      .where(
        and(
          eq(tnOrders.ownerId, owner.id),
          eq(tnOrders.bucket, id),
          inArray(tnOrders.state, ["queued", "prepared", "submitted", "needs_review"]),
        ),
      );
    if (unsettled.length) {
      throw new TestnetError("conflict", "Wait for this agent's orders to settle, then restart it.");
    }
    const asset = testnetAsset(rule.assetId),
      location = rule.location ?? "wallet",
      amount = parseTokenAmount(rule.amount, asset.decimals),
      budget = parseTokenAmount(rule.budget, asset.decimals),
      own = await ownedBalance(tx, owner.id, rule.assetId, id, location),
      free = BigInt(own.units) - BigInt(own.held);
    if (free < amount) {
      const topUp = budget - free,
        manual = await ownedBalance(tx, owner.id, rule.assetId, "manual", location);
      if (BigInt(manual.units) - BigInt(manual.held) < topUp) {
        throw new TestnetError(
          "limit",
          `Restarting reserves its budget again: ${tokenText(topUp.toString(), asset.decimals)} ${asset.symbol} must be free in your test balance.`,
        );
      }
      await changeBalance(tx, owner.id, rule.assetId, -topUp, 0n, "manual", location);
      await changeBalance(tx, owner.id, rule.assetId, topUp, 0n, id, location);
    }
    await tx
      .update(tnAgents)
      .set({
        state: "running",
        reason: null,
        slot: agent.slot + 1,
        nextAt: Date.now(),
        // A restarted dip measures from now; when pricing is down, its first check sets the reference.
        ...(rule.kind === "dip" ? { reference } : {}),
      })
      .where(and(eq(tnAgents.id, id), eq(tnAgents.slot, agent.slot)));
  });
}
