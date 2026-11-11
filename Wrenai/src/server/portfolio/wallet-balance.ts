import "server-only";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction, NearRpcError, viewNearBalance } from "@/server/near/rpc";
import { type WalletBalanceView, WRAP_NEAR_CONTRACT } from "@/shared/portfolio-wallet";
import { tokenUnitsSchema } from "@/shared/token-units";

/** wNEAR units the wallet holds, which it can unwrap to native NEAR. A failed read is never presented as zero. */
export async function readWalletWnear(accountId: string, signal: AbortSignal): Promise<string> {
  try {
    const result = await callViewFunction(
      WRAP_NEAR_CONTRACT,
      "ft_balance_of",
      { account_id: accountId },
      signal,
    );
    return tokenUnitsSchema.parse(result.value);
  } catch (error) {
    if (error instanceof NearRpcError) {
      throw new ExecutionError("not_ready", "The wNEAR balance could not be refreshed.");
    }
    throw error;
  }
}

export type WalletBalanceReading =
  | { readonly kind: "balance"; readonly yocto: bigint; readonly readAt: number }
  | { readonly kind: "no_account"; readonly readAt: number }
  | { readonly kind: "unavailable" };

/** Reads native NEAR only. A failed read is never presented as a zero balance. */
export async function readWalletBalance(
  accountId: string,
  signal?: AbortSignal,
): Promise<WalletBalanceReading> {
  try {
    const yocto = await viewNearBalance(accountId, signal);
    const readAt = Date.now();
    return yocto === null ? { kind: "no_account", readAt } : { kind: "balance", yocto, readAt };
  } catch (error) {
    if (error instanceof NearRpcError) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export async function readWalletBalanceView(
  accountId: string,
  signal: AbortSignal,
): Promise<WalletBalanceView> {
  const balance = await readWalletBalance(accountId, signal);
  if (balance.kind === "unavailable") {
    throw new ExecutionError("not_ready", "The NEAR balance could not be refreshed.");
  }
  return { yocto: balance.kind === "balance" ? balance.yocto.toString() : null, readAt: balance.readAt };
}
