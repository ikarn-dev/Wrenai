import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { perpsStateSchema } from "@/server/engine/perps-state";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { policySchema } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";
import { currentAgentStrategy } from "../asset-review";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { reserveDefiExecution } from "../defi-reservations";
import { availableInventory } from "../inventory";
import { confirmExecutionPermission } from "../permissions";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "../records";
import { synchronizePerpsInventory } from "./account-state";
import { perpsCashAssetId, perpsInstrumentId } from "./contracts";
import { hlText, hlUnits } from "./decimal";
import { readHlMarket } from "./market";
import { composePerpsOrder } from "./order-plan";
import { hlOrderRecordSchema, readHlOrder } from "./order-record";

/** One agent/address/market position. A current runtime slot, exact owned size and owner lock bind every order. */
export async function preparePerpsExecution(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
  requestId: string,
  exitReason: "stop_loss" | "take_profit" | "trailing" | "expiry" | null = null,
): Promise<LedgerAction> {
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  if (existing) {
    if (existing.agentId !== agentId || existing.scope !== "hyperliquid") {
      throw new ExecutionError("conflict", "This order request belongs to another action.");
    }
    await readHlOrder(db, existing);
    return existing;
  }
  const current = await currentAgentStrategy(db, userId, agentId, revision),
    instruction = current.strategy;
  const account = await readAgentTradingAccount(db, userId, agentId);
  if (instruction.kind !== "perps" || !account || current.agent.status !== "running") {
    throw new ExecutionError(
      "not_ready",
      "A current Perps instruction and backed-up agent address are required.",
    );
  }
  const market = await readHlMarket(instruction.market),
    observation = await synchronizePerpsInventory(db, userId, agentId);
  const cashAsset = perpsCashAssetId(account.perpAddress),
    instrument = perpsInstrumentId(account.perpAddress, instruction.market),
    policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  return userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx),
      [runtime] = await tx.select().from(agentRuntimes).where(eq(agentRuntimes.agentId, agentId)).limit(1);
    const state = runtime?.strategyStateJson
      ? perpsStateSchema.parse(JSON.parse(runtime.strategyStateJson))
      : null;
    if (
      runtime?.userId !== userId ||
      runtime.state !== "active" ||
      state?.pendingSlot !== requestId ||
      state.pendingActionId !== null
    ) {
      throw new ExecutionError("not_ready", "The order has no persisted reviewed decision slot.");
    }
    const [pending] = await tx
      .select()
      .from(executionActions)
      .where(and(eq(executionActions.agentId, agentId), isNull(executionActions.reservationReleasedAt)))
      .limit(1);
    if (pending) {
      throw new ExecutionError("conflict", "Reconcile the previous venue action before another order.");
    }
    const rows = await tx
      .select()
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, userId),
          eq(defiPositions.agentId, agentId),
          eq(defiPositions.scope, "hyperliquid"),
          eq(defiPositions.instrumentId, instrument),
        ),
      );
    const kind = instruction.side === "long" ? "perp_long" : "perp_short",
      exposure = rows.find((p) => p.kind === kind),
      collateral = rows.find((p) => p.kind === "collateral"),
      owned = exposure?.quantityUnits ?? 0n;
    const actualPosition = observation.assetPositions.find(
      (p) => p.position.coin === instruction.market,
    )?.position;
    const actual = actualPosition ? hlUnits(actualPosition.szi, market.sizeDecimals) : 0n;
    if (
      observation.assetPositions.some(
        (p) => p.position.coin !== instruction.market && hlUnits(p.position.szi, 18) !== 0n,
      ) ||
      actual !== (instruction.side === "long" ? owned : -owned) ||
      rows.some((p) => p.kind !== kind && p.kind !== "collateral" && p.quantityUnits > 0n)
    ) {
      throw new ExecutionError(
        "not_ready",
        "Unreconciled or unmanaged venue exposure must be resolved before another order.",
      );
    }
    const ownedCash = await unreservedOwnedUnits(tx, userId, agentId, "hyperliquid", cashAsset),
      observedCash = await availableInventory(tx, userId, "hyperliquid", cashAsset, now);
    const available = minimumUnits(ownedCash, observedCash);
    const effective =
      exitReason === null
        ? instruction
        : agentInstructionSchema.parse({
            ...instruction,
            action: "close",
            quantity: hlText(owned, market.sizeDecimals),
          });
    if (effective.kind !== "perps") {
      throw new ExecutionError("conflict", "The reviewed instruction is not a perpetual order.");
    }
    const composed = composePerpsOrder(effective, policy, market, requestId, available, owned),
      opening = effective.action === "open";
    if (opening ? state.phase !== "entry" : state.phase !== "holding") {
      throw new ExecutionError("conflict", "The runtime phase does not authorize this order direction.");
    }
    const exposureId = exposure?.id ?? randomUUID(),
      collateralId = collateral?.id ?? randomUUID(),
      afterMaximum = opening ? composed.quantityUnits : owned;
    const permissionHash = await confirmExecutionPermission(tx, userId, {
      agentId,
      agentRevision: revision,
      strategyVersion: current.agent.version,
      scope: "hyperliquid",
      venueId: "hyperliquid",
      signingPublicKey: account.perpAddress,
      operations: ["perp_open", "perp_reduce"],
      assetIds: [cashAsset],
      instruments: [
        { kind, instrumentId: instrument, maxUnits: (afterMaximum > 0n ? afterMaximum : 1n).toString() },
        {
          kind: "collateral",
          instrumentId: instrument,
          maxUnits: (composed.maximumCashDebit + (collateral?.quantityUnits ?? 0n) + 1n).toString(),
        },
      ],
      recipients: [],
      expiresAt: null,
    });
    const maximumAfter = opening ? composed.quantityUnits : owned - composed.quantityUnits;
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId,
      agentId,
      agentRevision: revision,
      strategyVersion: current.agent.version,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      ...(!opening && policy.allowRiskReducingExits ? { reduceOnly: true } : {}),
      scope: "hyperliquid",
      venueId: "hyperliquid",
      operation: opening ? "perp_open" : "perp_reduce",
      permissionHash,
      cash: [
        { assetId: cashAsset, maxDebitUnits: composed.maximumCashDebit.toString(), minCreditUnits: "0" },
      ],
      positions: [
        {
          positionId: exposureId,
          kind,
          instrumentId: instrument,
          expectedVersion: exposure?.version ?? 0,
          beforeUnits: owned.toString(),
          minAfterUnits: "0",
          maxAfterUnits: (opening ? maximumAfter : owned - 1n).toString(),
        },
        {
          positionId: collateralId,
          kind: "collateral",
          instrumentId: instrument,
          expectedVersion: collateral?.version ?? 0,
          beforeUnits: (collateral?.quantityUnits ?? 0n).toString(),
          minAfterUnits: "0",
          maxAfterUnits: (opening ? composed.maximumCashDebit : (collateral?.quantityUnits ?? 0n)).toString(),
        },
      ],
      notionalMicroUsd: composed.notionalMicroUsd.toString(),
      slippageBps: policy.maxSlippageBps,
      providerFeeBps: policy.maxProviderFeeBps,
      quoteId: `hl:${requestId}`,
      quoteHash: executionHash({ market, account: observation }),
      payloadHash: executionHash(composed.action),
      recipient: null,
      expiresAt: Math.min(now + 15_000, market.observedAt + 15_000),
    });
    const action = await reserveDefiExecution(tx, userId, plan);
    const record = hlOrderRecordSchema.parse({
      format: 1,
      address: account.perpAddress,
      instructionHash: executionHash(instruction),
      role: opening ? "entry" : "exit",
      exitReason: exitReason ?? (opening ? null : "user"),
      action: composed.action,
      leverage: composed.leverage,
      market,
      account: observation,
      availableCashUnits: available.toString(),
      beforeCashUnits: hlUnits(observation.crossMarginSummary.totalRawUsd, 6, "down").toString(),
      requestedUnits: composed.quantityUnits.toString(),
      beforeCollateralUnits: (collateral?.quantityUnits ?? 0n).toString(),
      beforeExposureUnits: owned.toString(),
      beforeCollateralPrincipal: (collateral?.principalMicroUsd ?? 0n).toString(),
    });
    await executionEvent(tx, action, "hl_prepared", now, record);
    return action;
  });
}
