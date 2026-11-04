import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { callViewFunction } from "@/server/near/rpc";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeAsset } from "@/shared/trade-preview";
import { ExecutionError, executionPlanSchema } from "../contracts";
import { executionHash, type LedgerAction } from "../records";
import { MAX_NATIVE_GAS_UNITS, type RheaPrepared, rheaPreparedSchema, rheaSwapCall } from "./contracts";
import { quoteRhea } from "./quote";

export async function prepareRheaOrder(
  db: AppDatabase,
  userId: string,
  input: TradeAsset,
  output: TradeAsset,
  units: string,
  slippageBps: number,
  poolId: string,
): Promise<RheaPrepared> {
  const root = await activeTradingAccount(db, userId);
  if (!root?.backupConfirmedAt) {
    throw new ExecutionError("not_ready", "Save your encrypted recovery backup before native trading.");
  }
  const quote = await quoteRhea(input, output, units, slippageBps, poolId);
  const storage = await callViewFunction(output.assetId.slice(7), "storage_balance_of", {
    account_id: root.nativeAccountId,
  });
  let registrationDeposit: string | null = null;
  if (storage.value === null) {
    registrationDeposit = z
      .object({ min: positiveTokenUnitsSchema })
      .parse((await callViewFunction(output.assetId.slice(7), "storage_balance_bounds", {})).value).min;
    if (BigInt(registrationDeposit) > MAX_NATIVE_GAS_UNITS / 2n) {
      throw new ExecutionError("limit", "Token registration exceeds the native fee allowance.");
    }
  } else {
    z.object({ total: positiveTokenUnitsSchema }).parse(storage.value);
  }
  const prepared = rheaPreparedSchema.parse({
    format: 1,
    accountId: root.nativeAccountId,
    rootId: root.id,
    quote,
    registrationDeposit,
    quoteHash: executionHash(quote),
    payloadHash: "0".repeat(64),
  });
  return {
    ...prepared,
    payloadHash: executionHash({
      swap: rheaSwapCall(prepared),
      registrationDeposit,
      accountId: root.nativeAccountId,
    }),
  };
}
export async function readRheaPrepared(db: AppDatabase, action: LedgerAction): Promise<RheaPrepared> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "rhea_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("conflict", "The native order has no unique preparation record.");
  }
  const prepared = rheaPreparedSchema.parse(JSON.parse(rows[0].detailJson));
  if (
    prepared.quoteHash !== executionHash(prepared.quote) ||
    prepared.payloadHash !==
      executionHash({
        swap: rheaSwapCall(prepared),
        registrationDeposit: prepared.registrationDeposit,
        accountId: prepared.accountId,
      })
  ) {
    throw new ExecutionError("conflict", "The native call differs from its bound quote.");
  }
  const plan = executionPlanSchema.parse(JSON.parse(action.planJson));
  if (
    action.scope !== "native_near" ||
    action.kind !== "swap" ||
    plan.quoteHash !== prepared.quoteHash ||
    plan.quoteId !== prepared.quote.poolId ||
    plan.inputAssetId !== prepared.quote.input.assetId ||
    plan.outputAssetId !== prepared.quote.output.assetId ||
    plan.inputUnits !== prepared.quote.inputUnits ||
    plan.minOutputUnits !== prepared.quote.minimumOutputUnits ||
    plan.expiresAt !== prepared.quote.expiresAt ||
    executionHash(plan) !== action.planHash
  ) {
    throw new ExecutionError("conflict", "The native quote differs from the reserved action.");
  }
  return prepared;
}
