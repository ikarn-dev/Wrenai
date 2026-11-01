import "server-only";
import { NearRpcError, viewNearBalance } from "@/server/near/rpc";

export type WalletBalanceReading =
  | { readonly kind: "balance"; readonly yocto: bigint; readonly readAt: number }
  | { readonly kind: "no_account"; readonly readAt: number }
  | { readonly kind: "unavailable" };

/** Reads native NEAR only. A failed read is never presented as a zero balance. */
export async function readWalletBalance(accountId: string): Promise<WalletBalanceReading> {
  try {
    const yocto = await viewNearBalance(accountId);
    const readAt = Date.now();
    return yocto === null ? { kind: "no_account", readAt } : { kind: "balance", yocto, readAt };
  } catch (error) {
    if (error instanceof NearRpcError) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}
