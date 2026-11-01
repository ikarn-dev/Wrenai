import "server-only";
import { base64 } from "@scure/base";
import { z } from "zod";
import { serverEnv } from "@/server/env";

const RPC_TIMEOUT_MS = 8_000;

export class NearRpcError extends Error {
  readonly code = "near_rpc_unavailable";
}

const rpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string().optional(),
      cause: z.object({ name: z.string() }).optional(),
    })
    .optional(),
});

// A missing key comes back as a result with an `error` string, not as an RPC error.
const accessKeyResultSchema = z.union([
  z.object({ permission: z.union([z.literal("FullAccess"), z.object({ FunctionCall: z.unknown() })]) }),
  z.object({ error: z.string() }),
]);

const accountResultSchema = z.object({ amount: z.string().regex(/^\d+$/) });

// A contract panic also arrives as a result with an `error` string (checked on intents.near, Oct 26, 2026).
const viewResultSchema = z.union([
  z.object({
    result: z.array(z.number().int().min(0).max(255)),
    block_height: z.number().int().nonnegative(),
  }),
  z.object({ error: z.string() }),
]);

export interface ViewResult {
  /** The method's return value, parsed from JSON. */
  readonly value: unknown;
  /** The final block the value was read at. RPC nodes can lag one another, so callers compare heights. */
  readonly blockHeight: number;
}

type QueryOutcome = { readonly kind: "ok"; readonly result: unknown } | { readonly kind: "unknown_account" };

async function query(params: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<QueryOutcome> {
  let response: Response;
  try {
    response = await fetch(serverEnv().nearRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "wrenai/0.1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wrenai",
        method: "query",
        params: { ...params, finality: "final" },
      }),
      signal: AbortSignal.any([AbortSignal.timeout(RPC_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      cache: "no-store",
    });
  } catch (error) {
    throw new NearRpcError("NEAR RPC could not be reached", { cause: error });
  }
  if (!response.ok) {
    throw new NearRpcError(`NEAR RPC returned HTTP ${response.status}`);
  }
  const body = rpcResponseSchema.safeParse(await response.json());
  if (!body.success) {
    throw new NearRpcError("NEAR RPC returned an unexpected response");
  }
  const { error, result } = body.data;
  if (error !== undefined) {
    if (error.cause?.name === "UNKNOWN_ACCOUNT") {
      return { kind: "unknown_account" };
    }
    throw new NearRpcError(`NEAR RPC error: ${error.cause?.name ?? error.message ?? "unknown"}`);
  }
  return { kind: "ok", result };
}

/** True when `publicKey` is a full-access key of `accountId` on mainnet. */
export async function hasFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  const outcome = await query({
    request_type: "view_access_key",
    account_id: accountId,
    public_key: publicKey,
  });
  if (outcome.kind === "unknown_account") {
    return false;
  }
  const parsed = accessKeyResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    throw new NearRpcError("NEAR RPC returned an unexpected access key");
  }
  return "permission" in parsed.data && parsed.data.permission === "FullAccess";
}

/** Liquid NEAR balance in yoctoNEAR, or null when the account doesn't exist on chain yet. */
export async function viewNearBalance(accountId: string, signal?: AbortSignal): Promise<bigint | null> {
  const outcome = await query({ request_type: "view_account", account_id: accountId }, signal);
  if (outcome.kind === "unknown_account") {
    return null;
  }
  const parsed = accountResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    throw new NearRpcError("NEAR RPC returned an unexpected account");
  }
  return BigInt(parsed.data.amount);
}

/**
 * Calls a contract view method at final finality. Throws NearRpcError when NEAR can't be reached, and a plain
 * Error when the contract rejects the call: that means our arguments are wrong, not that NEAR is down.
 */
export async function callViewFunction(
  contractId: string,
  methodName: string,
  args: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
  signal?: AbortSignal,
): Promise<ViewResult> {
  const outcome = await query(
    {
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
    },
    signal,
  );
  if (outcome.kind === "unknown_account") {
    throw new Error(`Contract ${contractId} doesn't exist on mainnet`);
  }
  const parsed = viewResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    throw new NearRpcError("NEAR RPC returned an unexpected view result");
  }
  if ("error" in parsed.data) {
    throw new Error(`${contractId}.${methodName} failed: ${parsed.data.error}`);
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(parsed.data.result)));
  return { value, blockHeight: parsed.data.block_height };
}
