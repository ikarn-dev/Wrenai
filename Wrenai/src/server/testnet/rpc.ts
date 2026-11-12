import "server-only";
import { z } from "zod";
import { tradingResponseJson } from "@/server/execution/trading-http";
import { testnetAsset } from "@/shared/testnet";
import { tokenUnitsSchema } from "@/shared/token-units";
import { TestnetError, testnetEnv } from "./config";

export class TestnetRpcError extends TestnetError {
  constructor(
    method: string,
    readonly rpcCause: string | null,
  ) {
    super(
      "unavailable",
      method === "tx" || method.startsWith("broadcast_")
        ? "Transaction status is unavailable. Check its status before sending again."
        : rpcCause === "UNKNOWN_ACCOUNT"
          ? "This account is not active on NEAR Testnet."
          : "Could not load testnet data. Try again shortly.",
    );
    this.name = "TestnetRpcError";
  }
}

export async function testnetRpc(method: string, params: unknown): Promise<unknown> {
  const endpoint = testnetEnv().TESTNET_RPC_URL;
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "wrenai-testnet", method, params }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const v = z
      .object({ result: z.unknown().optional(), error: z.unknown().optional() })
      .parse(await tradingResponseJson(r, 4_000_000, true));
    if (v.error !== undefined || v.result === undefined) {
      const error = z.object({ cause: z.object({ name: z.string() }).optional() }).safeParse(v.error);
      throw new TestnetRpcError(method, error.success ? (error.data.cause?.name ?? null) : null);
    }
    return v.result;
  } catch (error) {
    if (error instanceof TestnetRpcError) {
      throw error;
    }
    throw new TestnetRpcError(method, null);
  }
}
export async function testnetChain(): Promise<void> {
  const status = z.object({ chain_id: z.literal("testnet") }).safeParse(await testnetRpc("status", {}));
  if (!status.success) {
    throw new TestnetError("unavailable", "This RPC is not NEAR Testnet.");
  }
}
export async function testnetView(accountId: string, method: string, args: unknown): Promise<unknown> {
  // Lossless RPC parsing preserves every numeric literal as text, including bounded result bytes.
  const byte = z
    .union([z.number(), z.string().regex(/^(?:0|[1-9]\d{0,2})$/)])
    .transform((value) => Number(value))
    .pipe(z.number().int().min(0).max(255));
  const r = z.object({ result: z.array(byte) }).safeParse(
    await testnetRpc("query", {
      request_type: "call_function",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    }),
  );
  if (!r.success) {
    throw new TestnetRpcError("query", "INVALID_CONTRACT_RESULT");
  }
  try {
    return JSON.parse(Buffer.from(r.data.result).toString("utf8"));
  } catch {
    throw new TestnetRpcError("query", "INVALID_CONTRACT_RESULT");
  }
}
export async function testnetBalance(accountId: string, assetId: string): Promise<bigint> {
  const asset = testnetAsset(assetId);
  if (asset.contract) {
    const meta = z
      .object({ decimals: z.literal(asset.decimals) })
      .safeParse(await testnetView(asset.contract, "ft_metadata", {}));
    if (!meta.success) {
      throw new TestnetRpcError("query", "INVALID_TOKEN_METADATA");
    }
    const units = tokenUnitsSchema.safeParse(
      await testnetView(asset.contract, "ft_balance_of", { account_id: accountId }),
    );
    if (!units.success) {
      throw new TestnetRpcError("query", "INVALID_TOKEN_BALANCE");
    }
    return BigInt(units.data);
  }
  let account: unknown;
  try {
    account = await testnetRpc("query", {
      request_type: "view_account",
      account_id: accountId,
      finality: "final",
    });
  } catch (error) {
    // A finalized UNKNOWN_ACCOUNT is known zero native balance, not a provider outage.
    if (error instanceof TestnetRpcError && error.rpcCause === "UNKNOWN_ACCOUNT") {
      return 0n;
    }
    throw error;
  }
  const r = z
    .object({
      amount: tokenUnitsSchema,
      locked: tokenUnitsSchema,
      storage_usage: z.coerce.number().int().nonnegative().safe(),
    })
    .safeParse(account);
  if (!r.success) {
    throw new TestnetRpcError("query", "INVALID_ACCOUNT_RESULT");
  }
  const protocol = z
    .object({
      chain_id: z.literal("testnet"),
      runtime_config: z.object({ storage_amount_per_byte: tokenUnitsSchema }),
    })
    .safeParse(await testnetRpc("EXPERIMENTAL_protocol_config", { finality: "final" }));
  if (!protocol.success) {
    throw new TestnetRpcError("query", "INVALID_PROTOCOL_RESULT");
  }
  const cost = BigInt(r.data.storage_usage) * BigInt(protocol.data.runtime_config.storage_amount_per_byte),
    locked = BigInt(r.data.locked),
    liquid = BigInt(r.data.amount);
  return liquid > (cost > locked ? cost - locked : 0n) ? liquid - (cost > locked ? cost - locked : 0n) : 0n;
}
export const callSchema = z.object({
  receiverId: z.string(),
  method: z.string().nullable(),
  args: z.record(z.string(), z.unknown()),
  deposit: tokenUnitsSchema,
  gas: tokenUnitsSchema,
});
export type TestnetCall = z.infer<typeof callSchema>;
export async function tokenRegistration(token: string, recipient: string): Promise<TestnetCall[]> {
  const current = await testnetView(token, "storage_balance_of", { account_id: recipient });
  if (current !== null) {
    if (!z.object({ total: tokenUnitsSchema }).safeParse(current).success) {
      throw new TestnetRpcError("query", "INVALID_STORAGE_RESULT");
    }
    return [];
  }
  const bounds = z
    .object({ min: tokenUnitsSchema })
    .safeParse(await testnetView(token, "storage_balance_bounds", {}));
  if (!bounds.success) {
    throw new TestnetRpcError("query", "INVALID_STORAGE_RESULT");
  }
  if (BigInt(bounds.data.min) > 10n ** 22n) {
    throw new TestnetError("limit", "Token storage exceeds the testnet registration limit.");
  }
  return [
    {
      receiverId: token,
      method: "storage_deposit",
      args: { account_id: recipient, registration_only: true },
      gas: "30000000000000",
      deposit: bounds.data.min,
    },
  ];
}
export async function transferCalls(
  assetId: string,
  units: string,
  recipient: string,
): Promise<TestnetCall[]> {
  const token = testnetAsset(assetId);
  if (!token.contract) {
    try {
      await testnetRpc("query", { request_type: "view_account", account_id: recipient, finality: "final" });
    } catch (error) {
      if (!(error instanceof TestnetRpcError) || error.rpcCause !== "UNKNOWN_ACCOUNT") {
        throw error;
      }
      // NEAR creates an Ed25519 implicit account when its exact public-key address receives native NEAR.
      if (!/^[a-f0-9]{64}$/.test(recipient)) {
        throw new TestnetError("invalid_input", "The recipient does not exist on NEAR Testnet.");
      }
    }
    return [{ receiverId: recipient, method: null, args: {}, deposit: units, gas: "0" }];
  }
  return [
    ...(await tokenRegistration(token.contract, recipient)),
    {
      receiverId: token.contract,
      method: "ft_transfer",
      args: { receiver_id: recipient, amount: units, memo: "Wrenai testnet" },
      deposit: "1",
      gas: "50000000000000",
    },
  ];
}
