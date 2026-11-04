import "server-only";
import { z } from "zod";
import { serverEnv } from "@/server/env";
import { ExecutionError } from "../contracts";
import { tradingResponseJson } from "../trading-http";

export async function nativeRpc(
  method: "query" | "gas_price" | "broadcast_tx_async",
  params: unknown,
): Promise<unknown> {
  const response = await fetch(serverEnv().nearRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "wrenai-native", method, params }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const value = z
    .object({ result: z.unknown().optional(), error: z.unknown().optional() })
    .parse(await tradingResponseJson(response, 256_000, true));
  if (value.error !== undefined || value.result === undefined) {
    throw new ExecutionError(
      "not_ready",
      "The native transaction or account observation could not be confirmed.",
    );
  }
  return value.result;
}
export async function nativeSigningState(
  accountId: string,
  publicKey: string,
): Promise<{ nonce: bigint; blockHash: string; gasPrice: bigint; observedAt: number }> {
  const key = z
    .object({
      nonce: z.string().regex(/^\d{1,20}$/),
      permission: z.literal("FullAccess"),
      block_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
    })
    .parse(
      await nativeRpc("query", {
        request_type: "view_access_key",
        account_id: accountId,
        public_key: publicKey,
        finality: "final",
      }),
    );
  const gas = z
    .object({ gas_price: z.string().regex(/^[1-9]\d{0,30}$/) })
    .parse(await nativeRpc("gas_price", { block_id: key.block_hash }));
  return {
    nonce: BigInt(key.nonce),
    blockHash: key.block_hash,
    gasPrice: BigInt(gas.gas_price),
    observedAt: Date.now(),
  };
}
