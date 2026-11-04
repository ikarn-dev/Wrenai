import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { perpsCashAssetId, perpsInstrumentId } from "@/server/execution/hyperliquid/contracts";
import { hlText, hlUnits } from "@/server/execution/hyperliquid/decimal";
import { readHlMarket } from "@/server/execution/hyperliquid/market";
import { composePerpsOrder } from "@/server/execution/hyperliquid/order-plan";
import { hlOrderRecordSchema } from "@/server/execution/hyperliquid/order-record";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { databaseTime, executionHash } from "@/server/execution/records";
import { intentTokens } from "@/server/research/intents";
import { ensureManualTradingAccount } from "@/server/trading-accounts/agent-account";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { type ManualPerpsIntent, manualPreviewSchema } from "@/shared/manual-trading";
import { manualAvailableUnits } from "./balances";
import { manualOrderPolicy } from "./policy";
import type { ManualEnvelope } from "./record";

export async function prepareManualPerps(
  db: AppDatabase,
  userId: string,
  id: string,
  subjectId: string,
  intent: ManualPerpsIntent,
): Promise<ManualEnvelope> {
  const account = await ensureManualTradingAccount(db, userId, subjectId);
  await watchPerpsPosition(db, userId, subjectId, false);
  const [market, observation, registry] = await Promise.all([
    readHlMarket(intent.market),
    synchronizePerpsInventory(db, userId, subjectId),
    intentTokens(),
  ]);
  const collateralToken = registry.tokens.find(
    (t) =>
      t.blockchain.toLowerCase() === "near" &&
      t.symbol.toUpperCase() === "USDC" &&
      /^nep141:/.test(t.assetId),
  );
  if (!collateralToken) {
    throw new ExecutionError("not_ready", "The supported collateral identity is unavailable.");
  }
  const cashAsset = perpsCashAssetId(account.perpAddress),
    instrument = perpsInstrumentId(account.perpAddress, market.name);
  return userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx);
    const rows = await tx
      .select()
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, userId),
          eq(defiPositions.agentId, subjectId),
          eq(defiPositions.scope, "hyperliquid"),
          eq(defiPositions.instrumentId, instrument),
        ),
      );
    const kind = intent.side === "long" ? "perp_long" : "perp_short",
      exposure = rows.find((p) => p.kind === kind),
      collateral = rows.find((p) => p.kind === "collateral"),
      owned = exposure?.quantityUnits ?? 0n;
    const position = observation.assetPositions.find((p) => p.position.coin === market.name)?.position;
    const actual = position ? hlUnits(position.szi, market.sizeDecimals) : 0n;
    if (
      observation.assetPositions.some(
        (p) => p.position.coin !== market.name && hlUnits(p.position.szi, 18) !== 0n,
      ) ||
      actual !== (intent.side === "long" ? owned : -owned) ||
      rows.some((p) => p.kind !== kind && p.kind !== "collateral" && p.quantityUnits > 0n)
    ) {
      throw new ExecutionError(
        "not_ready",
        "Close or reconcile the current manual position before trading another market or side.",
      );
    }
    const instruction = agentInstructionSchema.parse({
      format: 2,
      kind: "perps",
      market: market.name,
      collateralAssetId: collateralToken.assetId,
      action: intent.action,
      side: intent.side,
      quantity: intent.quantity,
      leverage: intent.leverage,
      marginMode: "isolated",
      maximumMarginUsd: intent.maximumMarginUsd,
      entry: { type: "market" },
      exits: {
        stopLossPrice: intent.stopLossPrice,
        takeProfitPrice: intent.takeProfitPrice,
        trailingStopBps: intent.trailingStopBps,
      },
      expiresAt: new Date(now + 60_000).toISOString(),
      onExpiry: "stop",
    });
    if (instruction.kind !== "perps") {
      throw new ExecutionError("conflict", "This is not a Perps trade.");
    }
    const available = await manualAvailableUnits(tx, userId, subjectId, "hyperliquid", cashAsset, now);
    const composed = composePerpsOrder(
        instruction,
        manualOrderPolicy(intent),
        market,
        id,
        available,
        owned,
        now,
      ),
      opening = intent.action === "open";
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId: id,
      agentId: subjectId,
      agentRevision: 1,
      strategyVersion: 1,
      riskPolicyRevision: 0,
      budgetMode: "manual",
      manualTradeId: id,
      ...(!opening ? { reduceOnly: true } : {}),
      scope: "hyperliquid",
      venueId: "hyperliquid",
      operation: opening ? "perp_open" : "perp_reduce",
      permissionHash: executionHash({ manualTradeId: id, intent }),
      cash: [
        { assetId: cashAsset, maxDebitUnits: composed.maximumCashDebit.toString(), minCreditUnits: "0" },
      ],
      positions: [
        {
          positionId: exposure?.id ?? randomUUID(),
          kind,
          instrumentId: instrument,
          expectedVersion: exposure?.version ?? 0,
          beforeUnits: owned.toString(),
          minAfterUnits: "0",
          maxAfterUnits: (opening ? composed.quantityUnits : owned - 1n).toString(),
        },
        {
          positionId: collateral?.id ?? randomUUID(),
          kind: "collateral",
          instrumentId: instrument,
          expectedVersion: collateral?.version ?? 0,
          beforeUnits: (collateral?.quantityUnits ?? 0n).toString(),
          minAfterUnits: "0",
          maxAfterUnits: (opening ? composed.maximumCashDebit : (collateral?.quantityUnits ?? 0n)).toString(),
        },
      ],
      notionalMicroUsd: composed.notionalMicroUsd.toString(),
      slippageBps: intent.slippageBps,
      providerFeeBps: intent.maximumFeeBps,
      quoteId: `hl:${id}`,
      quoteHash: executionHash({ market, account: observation }),
      payloadHash: executionHash(composed.action),
      recipient: null,
      expiresAt: Math.min(now + 15_000, market.observedAt + 15_000),
    });
    const prepared = hlOrderRecordSchema.parse({
      format: 1,
      address: account.perpAddress,
      instructionHash: executionHash(instruction),
      role: opening ? "entry" : "exit",
      exitReason: opening ? null : "user",
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
    const parent = composed.action.type === "order" ? composed.action.orders[0] : null;
    const preview = manualPreviewSchema.parse({
      id,
      revision: 1,
      bindingHash: "0".repeat(64),
      intent,
      title: `${opening ? "Open" : intent.action === "close" ? "Close" : "Reduce"} ${intent.side} · ${market.name}`,
      venue: "Hyperliquid",
      input: null,
      output: null,
      inputUnits: composed.quantityUnits.toString(),
      outputUnits: null,
      minimumOutputUnits: null,
      maximumDebit: `${hlText(composed.maximumCashDebit, 6)} USDC`,
      limitPrice: parent?.p ?? null,
      feeNote: `Fees capped at ${intent.maximumFeeBps / 100}%. Native TP/SL use bounded limit orders; gaps can delay fills.`,
      visibility: "public",
      expiresAt: plan.expiresAt,
      status: "quoted",
      actionId: null,
    });
    return { kind: "perps", preview, plan, prepared, instruction };
  });
}
