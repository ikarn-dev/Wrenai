import "server-only";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { callViewFunction } from "@/server/near/rpc";
import { tokenUnitsSchema } from "@/shared/token-units";
import { type TradeBalance, tradeBalanceSchema } from "@/shared/trade-preview";
import { privateBalanceToken } from "./balance-session";
import type { ExecutionScope } from "./contracts";
import { ExecutionError } from "./contracts";
import { tradingResponseJson } from "./trading-http";

/** Public balances are never substituted for a confidential account's balance. */
export async function freshTradingBalances(
  db: AppDatabase,
  userId: string,
  accountId: string,
  assetIds: readonly string[],
  scope: ExecutionScope,
): Promise<TradeBalance> {
  if (assetIds.length < 1 || assetIds.length > 6 || new Set(assetIds).size !== assetIds.length) {
    throw new ExecutionError("not_ready", "The balance request contains invalid assets.");
  }
  const startedAt = Date.now();
  if (scope !== "intents" && scope !== "confidential") {
    throw new ExecutionError(
      "not_ready",
      "Native and external venue balances require their own verified account adapter.",
    );
  }
  if (scope === "intents") {
    const result = await callViewFunction("intents.near", "mt_batch_balance_of", {
      account_id: accountId,
      token_ids: assetIds,
    });
    const balances = z.array(tokenUnitsSchema).length(assetIds.length).parse(result.value);
    return tradeBalanceSchema.parse({
      scope,
      status: "verified",
      observedAt: startedAt,
      blockHeight: result.blockHeight,
      balances: assetIds.map((assetId, index) => ({ assetId, units: balances[index] })),
      note: "Finalized public Intents inventory; native wallet and confidential funds are separate.",
    });
  }
  const token = await privateBalanceToken(db, userId);
  if (token === null) {
    return {
      scope,
      status: "unavailable",
      observedAt: startedAt,
      blockHeight: null,
      balances: [],
      note: "Connect your private balance with a read-only wallet signature. Public wallet funds cannot stand in for confidential funds.",
    };
  }
  const url = new URL("https://1click.chaindefuser.com/v0/account/balances");
  for (const assetId of assetIds) {
    url.searchParams.append("tokenIds", assetId);
  }
  const response = await fetch(url, {
    headers: { "User-Session": token, "User-Agent": "wrenai/0.1" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const rows = z
    .object({
      balances: z
        .array(
          z.object({
            tokenId: z.string().max(256),
            available: tokenUnitsSchema,
            source: z.literal("private"),
          }),
        )
        .max(6),
    })
    .parse(await tradingResponseJson(response, 64_000)).balances;
  if (
    new Set(rows.map((row) => row.tokenId)).size !== rows.length ||
    rows.some((row) => !assetIds.includes(row.tokenId))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The private balance response contains unexpected or duplicate assets.",
    );
  }
  return tradeBalanceSchema.parse({
    scope,
    status: rows.length === assetIds.length ? "verified" : "unavailable",
    observedAt: startedAt,
    blockHeight: null,
    balances: rows.map((row) => ({ assetId: row.tokenId, units: row.available })),
    note: "Authenticated private provider inventory, not a public-chain finality proof. Availability must be rechecked before signing.",
  });
}
