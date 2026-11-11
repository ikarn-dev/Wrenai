import "server-only";
import { and, eq } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { executionPermissions } from "@/server/db/defi-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "./contracts";
import { type DefiPlan, type ExecutionPermission, executionPermissionSchema } from "./defi-contracts";
import { databaseTime, executionHash } from "./records";

function allowedVenue(permission: ExecutionPermission): boolean {
  const operations = permission.operations;
  switch (permission.scope) {
    case "confidential":
      return permission.venueId === "confidential-intents" && operations.every((o) => o === "transfer");
    case "intents":
      return permission.venueId === "near-intents" && operations.every((o) => o === "transfer");
    case "hyperliquid":
      return (
        permission.venueId === "hyperliquid" &&
        operations.every((o) => o === "perp_open" || o === "perp_reduce" || o === "transfer")
      );
    case "native_near":
      return (
        (permission.venueId === "rhea-amm" &&
          operations.every((o) => o === "add_liquidity" || o === "remove_liquidity")) ||
        (permission.venueId === "rhea-lending" &&
          operations.every((o) => ["supply", "withdraw", "borrow", "repay"].includes(o))) ||
        (["meta-pool", "linear"].includes(permission.venueId) &&
          operations.every((o) => o === "stake" || o === "unstake")) ||
        // Owner wallet returns only; the recipient is checked against the owner before every signature.
        (permission.venueId === "near-account" && operations.every((o) => o === "transfer"))
      );
  }
}

/** Internal first-activation persistence. Caller must verify the owner's confirmation and signing identity first. */
export async function confirmExecutionPermission(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<string> {
  const permission = executionPermissionSchema.parse(raw);
  if (!allowedVenue(permission)) {
    throw new ExecutionError("not_ready", "This venue does not support the requested execution scope.");
  }
  const hash = executionHash(permission);
  return userTransaction(db, userId, async (tx) => {
    const agent = await ownedAgent(tx, userId, permission.agentId);
    const now = await databaseTime(tx);
    if (
      agent.revision !== permission.agentRevision ||
      agent.version !== permission.strategyVersion ||
      (permission.expiresAt !== null && permission.expiresAt <= now)
    ) {
      throw new ExecutionError(
        "conflict",
        "The execution permission is expired or belongs to a different agent revision.",
      );
    }
    const [existing] = await tx
      .select()
      .from(executionPermissions)
      .where(and(eq(executionPermissions.userId, userId), eq(executionPermissions.permissionHash, hash)))
      .limit(1);
    if (existing !== undefined && existing.revokedAt !== null) {
      throw new ExecutionError("conflict", "A revoked permission cannot be reactivated.");
    }
    if (existing === undefined) {
      await tx.insert(executionPermissions).values({
        userId,
        agentId: agent.id,
        permissionHash: hash,
        permissionJson: JSON.stringify(permission),
        confirmedAt: now,
        expiresAt: permission.expiresAt,
      });
    }
    return hash;
  });
}

export async function revokeExecutionPermission(
  db: AppDatabase,
  userId: string,
  permissionHash: string,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const [record] = await tx
      .select()
      .from(executionPermissions)
      .where(
        and(eq(executionPermissions.userId, userId), eq(executionPermissions.permissionHash, permissionHash)),
      )
      .limit(1);
    if (!record) {
      throw new ExecutionError("not_found", "Execution permission not found.");
    }
    if (record.revokedAt !== null) {
      return;
    }
    const [changed] = await tx
      .update(executionPermissions)
      .set({ revokedAt: await databaseTime(tx) })
      .where(
        and(eq(executionPermissions.userId, userId), eq(executionPermissions.permissionHash, permissionHash)),
      )
      .returning({ hash: executionPermissions.permissionHash });
    if (changed === undefined) {
      throw new ExecutionError("not_found", "Execution permission not found.");
    }
  });
}

export async function requireExecutionPermission(
  db: AppDatabase,
  userId: string,
  plan: DefiPlan,
  now: number,
): Promise<ExecutionPermission> {
  const [record] = await db
    .select()
    .from(executionPermissions)
    .where(
      and(
        eq(executionPermissions.userId, userId),
        eq(executionPermissions.permissionHash, plan.permissionHash),
      ),
    )
    .limit(1);
  if (!record || record.revokedAt !== null || (record.expiresAt !== null && record.expiresAt <= now)) {
    throw new ExecutionError("not_ready", "The reviewed venue permission is missing, expired or revoked.");
  }
  const p = executionPermissionSchema.parse(JSON.parse(record.permissionJson));
  if (
    executionHash(p) !== plan.permissionHash ||
    record.agentId !== plan.agentId ||
    p.agentId !== plan.agentId ||
    p.agentRevision > plan.agentRevision ||
    p.strategyVersion !== plan.strategyVersion ||
    p.scope !== plan.scope ||
    p.venueId !== plan.venueId ||
    !allowedVenue(p) ||
    !p.operations.includes(plan.operation) ||
    (plan.recipient !== null && !p.recipients.includes(plan.recipient)) ||
    plan.cash.some((a) => !p.assetIds.includes(a.assetId)) ||
    plan.positions.some(
      (position) =>
        !p.instruments.some(
          (i) =>
            i.kind === position.kind &&
            i.instrumentId === position.instrumentId &&
            BigInt(position.maxAfterUnits) <= BigInt(i.maxUnits),
        ),
    )
  ) {
    throw new ExecutionError("conflict", "This action differs from its owner-reviewed venue permission.");
  }
  return p;
}
