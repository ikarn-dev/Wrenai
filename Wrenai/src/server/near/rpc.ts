import "server-only";
import { base64 } from "@scure/base";
import { z } from "zod";
import { serverEnv } from "@/server/env";
import { nearAccountSchema } from "@/shared/agent-budget";

const RPC_TIMEOUT_MS = 8_000;

export class NearRpcError extends Error {
  override readonly name = "NearRpcError";
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
    block_hash: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
      .optional(),
  }),
  z.object({ error: z.string() }),
]);

export interface ViewResult {
  /** The method's return value, parsed from JSON. */
  readonly value: unknown;
  /** The final block the value was read at. RPC nodes can lag one another, so callers compare heights. */
  readonly blockHeight: number;
  readonly blockHash?: string;
}

type QueryOutcome = { readonly kind: "ok"; readonly result: unknown } | { readonly kind: "unknown_account" };

async function query(
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
  method = "query",
): Promise<QueryOutcome> {
  let response: Response;
  try {
    response = await fetch(serverEnv().nearRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "wrenai/0.1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wrenai",
        method,
        params:
          method === "tx" || method === "EXPERIMENTAL_tx_status" || "block_id" in params
            ? params
            : { ...params, finality: "final" },
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

/** Conservative wallet headroom: storage stake and 0.05 NEAR for gas remain unallocated. */
export async function viewNearBudgetBalance(
  accountId: string,
  reserveWalletGas = true,
  signal?: AbortSignal,
): Promise<{
  readonly balance: bigint;
  readonly spendable: bigint;
  readonly blockHeight: number;
}> {
  const [outcome, config] = await Promise.all([
    query({ request_type: "view_account", account_id: accountId }, signal),
    query({}, signal, "EXPERIMENTAL_protocol_config"),
  ]);
  if (outcome.kind !== "ok" || config.kind !== "ok") {
    throw new NearRpcError("The wallet account does not exist on mainnet.");
  }
  const value = z
    .object({
      amount: z.string().regex(/^\d+$/),
      locked: z.string().regex(/^\d+$/),
      storage_usage: z.number().int().nonnegative().safe(),
      block_height: z.number().int().positive().safe(),
    })
    .parse(outcome.result);
  // https://docs.near.org/protocol/storage/storage-staking; subtract full storage conservatively.
  const protocol = z
    .object({
      chain_id: z.literal("mainnet"),
      runtime_config: z.object({
        storage_amount_per_byte: z.string().regex(/^[1-9]\d{0,30}$/),
      }),
    })
    .parse(config.result);
  const storage = BigInt(value.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte);
  const locked = BigInt(value.locked);
  const reserve = (storage > locked ? storage - locked : 0n) + (reserveWalletGas ? 5n * 10n ** 22n : 0n);
  const balance = BigInt(value.amount);
  return { balance, spendable: balance > reserve ? balance - reserve : 0n, blockHeight: value.block_height };
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
  blockHash?: string,
): Promise<ViewResult> {
  const outcome = await query(
    {
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
      ...(blockHash
        ? {
            block_id: z
              .string()
              .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
              .parse(blockHash),
          }
        : {}),
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
  return {
    value,
    blockHeight: parsed.data.block_height,
    ...(parsed.data.block_hash ? { blockHash: parsed.data.block_hash } : {}),
  };
}

/** Read a known transaction only. FINAL waits for all execution receipts, including FT refunds. */
export async function readFinalTransaction(
  transactionHash: string,
  senderAccountId: string,
  includeReceipts = false,
): Promise<unknown> {
  z.string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
    .parse(transactionHash);
  const outcome = await query(
    { tx_hash: transactionHash, sender_account_id: senderAccountId, wait_until: "FINAL" },
    undefined,
    includeReceipts ? "EXPERIMENTAL_tx_status" : "tx",
  );
  if (
    outcome.kind !== "ok" ||
    (includeReceipts &&
      !z.object({ final_execution_status: z.literal("FINAL") }).safeParse(outcome.result).success)
  ) {
    throw new NearRpcError("The transaction could not be verified yet.");
  }
  return outcome.result;
}

/** Code identity and account keys at one final block; a global account reference can be upgraded. */
export async function readContractControl(
  account: string,
  blockHash?: string,
): Promise<{
  readonly codeHash: string;
  readonly globalCodeHash: string | null;
  readonly globalCodeAccount: string | null;
  readonly blockHash: string;
  readonly blockHeight: number;
  readonly keys: readonly unknown[];
}> {
  const accountId = nearAccountSchema.parse(account);
  const hash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  const result = await query({
    request_type: "view_account",
    account_id: accountId,
    ...(blockHash ? { block_id: hash.parse(blockHash) } : {}),
  });
  if (result.kind !== "ok") {
    throw new NearRpcError("The contract account does not exist.");
  }
  const value = z
    .object({
      code_hash: hash,
      global_contract_hash: hash.optional(),
      global_contract_account_id: nearAccountSchema.optional(),
      block_hash: hash,
      block_height: z.number().int().positive().safe(),
    })
    .parse(result.result);
  const keys = await query({
    request_type: "view_access_key_list",
    account_id: accountId,
    block_id: value.block_hash,
  });
  if (keys.kind !== "ok" || (blockHash && value.block_hash !== blockHash)) {
    throw new NearRpcError("The contract controls could not be read at the requested final block.");
  }
  const parsed = z.object({ keys: z.array(z.unknown()).max(1000), block_hash: hash }).parse(keys.result);
  if (parsed.block_hash !== value.block_hash) {
    throw new NearRpcError("The contract key observation changed blocks.");
  }
  return {
    codeHash: value.code_hash,
    globalCodeHash: value.global_contract_hash ?? null,
    globalCodeAccount: value.global_contract_account_id ?? null,
    blockHash: value.block_hash,
    blockHeight: value.block_height,
    keys: parsed.keys,
  };
}

/** Read a contract implementation at one finalized block without fetching its access-key list. */
export async function readContractCodeHash(
  account: string,
  blockHash?: string,
): Promise<{
  readonly codeHash: string;
  readonly globalCodeHash: string | null;
  readonly globalCodeAccount: string | null;
  readonly blockHash: string;
}> {
  const accountId = nearAccountSchema.parse(account);
  const hash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  const outcome = await query({
    request_type: "view_account",
    account_id: accountId,
    ...(blockHash ? { block_id: hash.parse(blockHash) } : {}),
  });
  if (outcome.kind !== "ok") {
    throw new NearRpcError("The contract account does not exist.");
  }
  const value = z
    .object({
      code_hash: hash,
      global_contract_hash: hash.optional(),
      global_contract_account_id: nearAccountSchema.optional(),
      block_hash: hash,
    })
    .parse(outcome.result);
  if (blockHash && value.block_hash !== blockHash) {
    throw new NearRpcError("The contract code observation changed blocks.");
  }
  return {
    codeHash: value.code_hash,
    globalCodeHash: value.global_contract_hash ?? null,
    globalCodeAccount: value.global_contract_account_id ?? null,
    blockHash: value.block_hash,
  };
}

export async function finalBlockTime(blockHash: string): Promise<number> {
  const outcome = await query(
    {
      block_id: z
        .string()
        .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
        .parse(blockHash),
    },
    undefined,
    "block",
  );
  if (outcome.kind !== "ok") {
    throw new NearRpcError("The final block time is unavailable.");
  }
  const block = z
    .object({ header: z.object({ hash: z.string(), timestamp_nanosec: z.string().regex(/^\d{1,20}$/) }) })
    .parse(outcome.result);
  if (block.header.hash !== blockHash) {
    throw new NearRpcError("The block timestamp belongs to a different observation.");
  }
  return Number(BigInt(block.header.timestamp_nanosec) / 1000000n);
}
