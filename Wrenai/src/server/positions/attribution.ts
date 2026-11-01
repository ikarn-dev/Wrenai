import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots, positionReservations } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { observedInventoryBalance } from "@/server/execution/inventory";
import { databaseTime } from "@/server/execution/records";
import { parseUsd, policySchema } from "@/shared/agents";
import {
  allocationCeiling,
  committedCapital,
  recordCapitalEvent,
  repeatedCapitalRequest,
} from "./capital-records";
import { inventoryAssignmentSchema, inventoryReleaseSchema } from "./contracts";
import { consumeFifoLots, unreservedOwnedUnits } from "./lots";

/** Internal authenticated-owner allocation of verified inventory. Evidence hashes are references, not proof verification. */
export async function assignInventory(db: AppDatabase, userId: string, raw: unknown): Promise<string> {
  const input = inventoryAssignmentSchema.parse(raw);
  return userTransaction(db, userId, async (tx) => {
    const repeated = await repeatedCapitalRequest(tx, userId, input.requestId, "inventory_assigned", input);
    if (repeated !== undefined) {
      return repeated;
    }
    const agent = await ownedAgent(tx, userId, input.agentId);
    const policy = policySchema.parse(JSON.parse(agent.policyJson));
    const cap = await allocationCeiling(tx, userId, input.agentId);
    const principal = (await committedCapital(tx, userId, input.agentId)) + BigInt(input.capitalMicroUsd);
    if (principal > cap || principal > parseUsd(policy.budgetUsd)) {
      throw new ExecutionError(
        "limit",
        "Attributed principal would exceed the agent's approved capital ceiling.",
      );
    }
    const now = await databaseTime(tx);
    const balance = await observedInventoryBalance(tx, userId, input.scope, input.assetId, now);
    const [attributed] = await tx
      .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.scope, input.scope),
          eq(positionLots.assetId, input.assetId),
        ),
      );
    const [legacy] = await tx
      .select({ units: sql<string>`coalesce(sum(${executionActions.inputUnits}), 0)::text` })
      .from(executionActions)
      .leftJoin(positionReservations, eq(positionReservations.actionId, executionActions.id))
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.scope, input.scope),
          eq(executionActions.inputAssetId, input.assetId),
          isNull(executionActions.reservationReleasedAt),
          isNull(positionReservations.actionId),
        ),
      );
    if (
      BigInt(input.quantityUnits) + BigInt(attributed?.units ?? "0") + BigInt(legacy?.units ?? "0") >
      balance
    ) {
      throw new ExecutionError(
        "insufficient_funds",
        "These units are unavailable, already attributed, or held by an unreviewed legacy action.",
      );
    }
    const id = randomUUID();
    const basis = input.costBasisMicroUsd === null ? null : BigInt(input.costBasisMicroUsd);
    await tx.insert(positionLots).values({
      id,
      userId,
      agentId: input.agentId,
      scope: input.scope,
      assetId: input.assetId,
      sourceId: id,
      sourceKind: "allocation",
      initialUnits: BigInt(input.quantityUnits),
      remainingUnits: BigInt(input.quantityUnits),
      initialBasisMicroUsd: basis,
      remainingBasisMicroUsd: basis,
      initialPrincipalMicroUsd: BigInt(input.capitalMicroUsd),
      remainingPrincipalMicroUsd: BigInt(input.capitalMicroUsd),
      openedAt: now,
    });
    await recordCapitalEvent(
      tx,
      userId,
      input.agentId,
      input.requestId,
      "inventory_assigned",
      input,
      id,
      now,
    );
    return id;
  });
}

/** Releases accounting attribution, not an on-chain transfer; it never realizes trading PnL. */
export async function releaseInventory(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = inventoryReleaseSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    if (
      (await repeatedCapitalRequest(tx, userId, input.requestId, "inventory_released", input)) !== undefined
    ) {
      return;
    }
    await ownedAgent(tx, userId, input.agentId);
    const now = await databaseTime(tx);
    const balance = await observedInventoryBalance(tx, userId, input.scope, input.assetId, now);
    const [all] = await tx
      .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.scope, input.scope),
          eq(positionLots.assetId, input.assetId),
        ),
      );
    if (balance < BigInt(all?.units ?? "0")) {
      throw new ExecutionError(
        "not_ready",
        "Reconcile the observed inventory shortfall before releasing attribution.",
      );
    }
    if (
      BigInt(input.quantityUnits) >
      (await unreservedOwnedUnits(tx, userId, input.agentId, input.scope, input.assetId))
    ) {
      throw new ExecutionError("insufficient_funds", "Reserved or another agent's units cannot be released.");
    }
    const consumed = await consumeFifoLots(
      tx,
      userId,
      input.agentId,
      input.scope,
      input.assetId,
      BigInt(input.quantityUnits),
    );
    await recordCapitalEvent(
      tx,
      userId,
      input.agentId,
      input.requestId,
      "inventory_released",
      input,
      input.agentId,
      now,
      {
        ...input,
        basisMicroUsd: consumed.basisMicroUsd?.toString() ?? null,
        principalMicroUsd: consumed.principalMicroUsd.toString(),
        lots: consumed.entries.map((entry) => ({
          lotId: entry.lotId,
          quantityUnits: entry.quantityUnits.toString(),
        })),
      },
    );
  });
}
