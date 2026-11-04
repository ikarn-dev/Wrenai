import "server-only";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { beginInventorySync, finishInventorySync } from "../inventory";
import { NATIVE_GAS_ASSET } from "./contracts";

export async function synchronizeNativeInventory(
  db: AppDatabase,
  userId: string,
  assets: readonly string[],
): Promise<void> {
  const root = await activeTradingAccount(db, userId);
  if (!root?.backupConfirmedAt) {
    throw new ExecutionError("not_ready", "Confirm a recovery backup before native trading.");
  }
  const ids = [...new Set([...assets, NATIVE_GAS_ASSET])];
  const syncToken = await beginInventorySync(db, userId, "native_near", ids);
  const observations = await Promise.allSettled(
    ids.map(async (assetId) => ({
      assetId,
      amountUnits:
        assetId === NATIVE_GAS_ASSET
          ? (await viewNearBudgetBalance(root.nativeAccountId, false)).spendable.toString()
          : tokenUnitsSchema.parse(
              (
                await callViewFunction(assetId.slice(7), "ft_balance_of", {
                  account_id: root.nativeAccountId,
                })
              ).value,
            ),
    })),
  );
  const failed = observations.find((r) => r.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
  const balances = observations.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  await finishInventorySync(db, userId, { scope: "native_near", syncToken, balances }, ids);
}
export async function nativeTokenAsset(assetId: string): Promise<{
  symbol: string;
  tokenSymbol: string;
  assetId: string;
  blockchain: string;
  contractAddress: string;
  decimals: number;
}> {
  const contract = z
    .string()
    .regex(/^nep141:[a-z0-9._-]{2,64}$/)
    .parse(assetId)
    .slice(7);
  const metadata = z
    .object({
      spec: z.literal("ft-1.0.0"),
      symbol: z.string().min(1).max(80),
      decimals: z.number().int().min(0).max(36),
    })
    .parse((await callViewFunction(contract, "ft_metadata", {})).value);
  return {
    symbol: assetId,
    tokenSymbol: metadata.symbol,
    assetId,
    blockchain: "near",
    contractAddress: contract,
    decimals: metadata.decimals,
  };
}
