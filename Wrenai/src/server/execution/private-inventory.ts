import "server-only";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { tokenUnitsSchema } from "@/shared/token-units";
import { privateBalanceToken } from "./balance-session";
import { ExecutionError } from "./contracts";
import { beginInventorySync, finishInventorySync } from "./inventory";
import { tradingResponseJson } from "./trading-http";

const completeBalancesSchema = z.strictObject({
  balances: z
    .array(
      z.object({
        tokenId: z
          .string()
          .max(256)
          .regex(/^nep141:[^\s:*]+$/),
        available: tokenUnitsSchema,
        source: z.literal("private"),
      }),
    )
    .max(500),
});

/** No token filter: the documented endpoint returns every non-zero private balance. Never use a partial preview here. */
export async function synchronizePrivateInventory(db: AppDatabase, userId: string): Promise<void> {
  const token = await privateBalanceToken(db, userId);
  if (token === null) {
    throw new ExecutionError("not_ready", "Connect your private balance before activating trading.");
  }
  const syncToken = await beginInventorySync(db, userId, "confidential");
  const rows = await readPrivateBalances(token);
  await finishInventorySync(db, userId, {
    scope: "confidential",
    syncToken,
    balances: rows.map((r) => ({ assetId: r.tokenId, amountUnits: r.available })),
  });
}

/** The same complete provider read can supply display estimates without mutating financial inventory. */
export async function readPrivateBalances(token: string): Promise<z.infer<typeof completeBalancesSchema>["balances"]> {
  const response = await fetch("https://1click.chaindefuser.com/v0/account/balances", {
    headers: { "User-Session": token, "User-Agent": "wrenai/0.1" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const rows = completeBalancesSchema.parse(await tradingResponseJson(response, 256_000)).balances;
  if (new Set(rows.map((r) => r.tokenId)).size !== rows.length) {
    throw new ExecutionError("not_ready", "The complete private inventory contains duplicate assets.");
  }
  return rows;
}
