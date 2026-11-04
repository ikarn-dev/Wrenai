import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agentSummary, auditAgent, listAgents, ownedAgent } from "@/server/agents/records";
import { fulfilSetupBudget } from "@/server/agents/setup-binding";
import type { SessionUser } from "@/server/auth/session";
import { agentEvents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { freshTradingBalances } from "@/server/execution/balances";
import { ExecutionError } from "@/server/execution/contracts";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { executionHash } from "@/server/execution/records";
import { assertNoWalletFunding } from "@/server/funding/records";
import { callViewFunction } from "@/server/near/rpc";
import { intentTokens } from "@/server/research/intents";
import { nearAccountSchema } from "@/shared/agent-budget";
import { instructionFundingAsset } from "@/shared/agent-instructions";
import { parseUsd, policySchema } from "@/shared/agents";
import { type AgentAllocationView, allocationCommandSchema } from "@/shared/allocation";
import { assignInventory, releaseInventory } from "./attribution";
import { setAgentCapitalLimit } from "./capital-limits";
import { committedCapital, repeatedCapitalRequest } from "./capital-records";
import { previewFifoLots, unreservedOwnedUnits } from "./lots";

function part(id: string, label: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["allocation-management:v1", id, label]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function repeatedMove(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof allocationCommandSchema>,
): Promise<boolean> {
  const [audit] = await db
    .select({ detail: agentEvents.detailJson })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.userId, userId),
        eq(agentEvents.kind, "allocation_moved"),
        sql`${agentEvents.detailJson}::jsonb ->> 'requestId' = ${input.requestId}`,
      ),
    )
    .limit(1);
  if (!audit) {
    return false;
  }
  if (
    z.object({ inputHash: z.string() }).parse(JSON.parse(audit.detail)).inputHash !== executionHash(input)
  ) {
    throw new ExecutionError(
      "conflict",
      "This allocation request already belongs to a different destination.",
    );
  }
  return true;
}
export async function readAgentAllocations(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentAllocationView> {
  const agent = await ownedAgent(db, userId, agentId);
  const [rows, registryResult, agents] = await Promise.all([
    db
      .select({
        scope: positionLots.scope,
        assetId: positionLots.assetId,
        units: sql<string>`sum(${positionLots.remainingUnits})::text`,
        principal: sql<string>`sum(${positionLots.remainingPrincipalMicroUsd})::text`,
      })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.agentId, agentId),
          gt(positionLots.remainingUnits, 0n),
          inArray(positionLots.scope, ["confidential", "intents"]),
        ),
      )
      .groupBy(positionLots.scope, positionLots.assetId)
      .limit(100),
    Promise.allSettled([intentTokens()]),
    listAgents(db, userId),
  ]);
  const registry = registryResult[0]?.status === "fulfilled" ? registryResult[0].value.tokens : [];
  const allocations: AgentAllocationView["allocations"][number][] = [];
  for (const row of rows) {
    const token =
      registry.find((token) => token.assetId === row.assetId) ??
      z
        .object({ symbol: z.string().min(1).max(64), decimals: z.number().int().min(0).max(36) })
        .parse(
          (await callViewFunction(nearAccountSchema.parse(row.assetId.slice(7)), "ft_metadata", {})).value,
        );
    if (row.scope !== "confidential" && row.scope !== "intents") {
      continue;
    }
    allocations.push({
      scope: row.scope,
      assetId: row.assetId,
      symbol: token.symbol,
      decimals: token.decimals,
      ownedUnits: row.units,
      availableUnits: (await unreservedOwnedUnits(db, userId, agentId, row.scope, row.assetId)).toString(),
      principalMicroUsd: row.principal,
    });
  }
  return {
    agentId,
    revision: agent.revision,
    running: agent.status === "running",
    allocations,
    targets: agents.flatMap((candidate) => {
      const assetId = "format" in candidate.strategy ? instructionFundingAsset(candidate.strategy) : null;
      return candidate.id !== agentId && candidate.status !== "running" && assetId
        ? [{ id: candidate.id, name: candidate.name, assetId }]
        : [];
    }),
  };
}
async function requireIdle(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<Awaited<ReturnType<typeof ownedAgent>>> {
  const agent = await ownedAgent(db, userId, agentId);
  await assertNoWalletFunding(db, userId, agentId);
  const [pending] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        isNull(executionActions.reservationReleasedAt),
      ),
    )
    .limit(1);
  if (agent.status === "running" || pending) {
    throw new ExecutionError(
      "not_ready",
      "Pause the agent and reconcile its orders before moving allocations.",
    );
  }
  return agent;
}
export async function manageAgentAllocation(db: AppDatabase, user: SessionUser, raw: unknown): Promise<void> {
  const input = allocationCommandSchema.parse(raw);
  if (await repeatedMove(db, user.id, input)) {
    return;
  }
  if (input.targetAgentId && input.scope !== "confidential") {
    throw new ExecutionError(
      "not_ready",
      "Move public funds into the private balance before assigning them to another agent.",
    );
  }
  const source = await requireIdle(db, user.id, input.agentId);
  if (input.targetAgentId === input.agentId || source.revision !== input.expectedRevision) {
    throw new ExecutionError("conflict", "The agent or destination changed. Refresh allocations.");
  }
  if (input.scope === "confidential") {
    await synchronizePrivateInventory(db, user.id);
  } else {
    const token = await beginInventorySync(db, user.id, "intents", [input.assetId]);
    const observed = await freshTradingBalances(db, user.id, user.accountId, [input.assetId], "intents");
    await finishInventorySync(
      db,
      user.id,
      {
        scope: "intents",
        syncToken: token,
        balances: observed.balances.map((balance) => ({
          assetId: balance.assetId,
          amountUnits: balance.units,
        })),
      },
      [input.assetId],
    );
  }
  await userTransaction(db, user.id, async (tx) => {
    if (await repeatedMove(tx, user.id, input)) {
      return;
    }
    const releaseId = part(input.requestId, "release");
    const release = {
      requestId: releaseId,
      agentId: input.agentId,
      scope: input.scope,
      assetId: input.assetId,
      quantityUnits: input.quantityUnits,
    };
    const repeated = await repeatedCapitalRequest(tx, user.id, releaseId, "inventory_released", release);
    if (repeated !== undefined) {
      throw new ExecutionError("conflict", "This release request already belongs to another operation.");
    }
    const agent = await requireIdle(tx, user.id, input.agentId);
    if (agent.revision !== input.expectedRevision) {
      throw new ExecutionError("conflict", "The agent changed. Refresh allocations.");
    }
    const lots = await previewFifoLots(
      tx,
      user.id,
      input.agentId,
      input.scope,
      input.assetId,
      BigInt(input.quantityUnits),
    );
    await releaseInventory(tx, user.id, release);
    if (input.targetAgentId) {
      const target = await requireIdle(tx, user.id, input.targetAgentId);
      const summary = await agentSummary(tx, target);
      if (!("format" in summary.strategy) || instructionFundingAsset(summary.strategy) !== input.assetId) {
        throw new ExecutionError("not_ready", "The destination must use this exact spending token.");
      }
      await setAgentCapitalLimit(tx, user.id, {
        requestId: part(input.requestId, "target-limit"),
        agentId: target.id,
        amountMicroUsd: parseUsd(policySchema.parse(JSON.parse(target.policyJson)).budgetUsd).toString(),
      });
      await assignInventory(tx, user.id, {
        requestId: part(input.requestId, "assign"),
        agentId: target.id,
        scope: input.scope,
        assetId: input.assetId,
        quantityUnits: input.quantityUnits,
        capitalMicroUsd: lots.principalMicroUsd.toString(),
        costBasisMicroUsd: lots.basisMicroUsd?.toString() ?? null,
        sourceReference: `reassign:${input.agentId}`,
        evidenceHash: executionHash(input),
      });
      await fulfilSetupBudget(tx, user.id, target.id, input.assetId, input.quantityUnits);
    }
    const [owned] = await tx
      .select({ id: positionLots.id })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, user.id),
          eq(positionLots.agentId, input.agentId),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .limit(1);
    const [position] = await tx
      .select({ id: defiPositions.id })
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, user.id),
          eq(defiPositions.agentId, input.agentId),
          gt(defiPositions.quantityUnits, 0n),
        ),
      )
      .limit(1);
    if (!owned && !position && (await committedCapital(tx, user.id, input.agentId)) === 0n) {
      await setAgentCapitalLimit(tx, user.id, {
        requestId: part(input.requestId, "source-limit"),
        agentId: input.agentId,
        amountMicroUsd: "0",
      });
    }
    await auditAgent(
      tx,
      user.id,
      input.agentId,
      "allocation_moved",
      input.targetAgentId
        ? "Reassigned unused funds to another agent."
        : "Released unused funds to the available balance.",
      { requestId: input.requestId, inputHash: executionHash(input) },
    );
  });
}
