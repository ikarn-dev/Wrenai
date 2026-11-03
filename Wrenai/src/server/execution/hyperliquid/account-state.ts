import "server-only";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { ExecutionError } from "../contracts";
import { beginInventorySync, finishInventorySync } from "../inventory";
import { hlAddressSchema, hlDecimalSchema, hlSignedDecimalSchema, perpsCashAssetId } from "./contracts";
import { hlUnits } from "./decimal";
import { hlInfo } from "./transport";

const summary = z.object({
  accountValue: hlSignedDecimalSchema,
  totalMarginUsed: hlDecimalSchema,
  totalNtlPos: hlDecimalSchema,
  totalRawUsd: hlSignedDecimalSchema,
});
export const hlAccountStateSchema = z.object({
  time: z.number().int().positive().safe(),
  withdrawable: hlDecimalSchema,
  crossMarginSummary: summary,
  marginSummary: summary,
  assetPositions: z
    .array(
      z.object({
        type: z.literal("oneWay"),
        position: z.object({
          coin: z.string().min(1).max(40),
          szi: hlSignedDecimalSchema,
          entryPx: hlDecimalSchema.nullable(),
          marginUsed: hlDecimalSchema,
          positionValue: hlDecimalSchema,
          unrealizedPnl: hlSignedDecimalSchema,
          leverage: z.object({
            type: z.enum(["cross", "isolated"]),
            value: z.number().int().positive(),
            rawUsd: hlSignedDecimalSchema.optional(),
          }),
        }),
      }),
    )
    .max(2000),
});
export type HlAccountState = z.infer<typeof hlAccountStateSchema>;
export async function readHlAccount(address: string): Promise<HlAccountState> {
  const state = hlAccountStateSchema.parse(
    await hlInfo({ type: "clearinghouseState", user: hlAddressSchema.parse(address) }),
  );
  if (
    state.time > Date.now() + 1000 ||
    Date.now() - state.time >= 15_000 ||
    new Set(state.assetPositions.map((p) => p.position.coin)).size !== state.assetPositions.length
  ) {
    throw new ExecutionError("not_ready", "The Perps account observation is stale or inconsistent.");
  }
  // Derived accounts are intentionally isolated-only. A recovery wallet's manual cross position is not app-owned collateral.
  if (
    state.assetPositions.some(
      (p) => p.position.leverage.type !== "isolated" && hlUnits(p.position.szi, 18) !== 0n,
    ) ||
    hlUnits(state.crossMarginSummary.totalNtlPos, 6, "up") !== 0n
  ) {
    throw new ExecutionError(
      "not_ready",
      "An unmanaged cross-margin position must be closed before this agent can trade.",
    );
  }
  return state;
}
/** A single derived address is partial scope coverage; never zero another agent's cash. */
export async function synchronizePerpsInventory(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<HlAccountState> {
  const account = await readAgentTradingAccount(db, userId, agentId);
  if (!account) {
    throw new ExecutionError("not_ready", "Create the backed-up Perps trading address first.");
  }
  const assetId = perpsCashAssetId(account.perpAddress);
  const syncToken = await beginInventorySync(db, userId, "hyperliquid", [assetId]);
  const state = await readHlAccount(account.perpAddress),
    cash = hlUnits(state.crossMarginSummary.totalRawUsd, 6, "down");
  if (cash < 0n) {
    throw new ExecutionError("not_ready", "The Perps account has a negative cash balance.");
  }
  await finishInventorySync(
    db,
    userId,
    { scope: "hyperliquid", syncToken, balances: [{ assetId, amountUnits: cash.toString() }] },
    [assetId],
  );
  return state;
}
