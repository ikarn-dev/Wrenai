import { z } from "zod";
import { tokenUnitsSchema } from "./token-units";

export const walletBalanceViewSchema = z.strictObject({
  yocto: tokenUnitsSchema.nullable(),
  readAt: z.number().int().positive(),
});
export const walletValueViewSchema = z.strictObject({
  knownMicroUsd: tokenUnitsSchema,
  complete: z.boolean(),
  otherTokens: z.number().int().nonnegative(),
});

export const PORTFOLIO_WALLET_KEY = ["portfolio-wallet"] as const;
export const PORTFOLIO_WALLET_BALANCE_KEY = [...PORTFOLIO_WALLET_KEY, "balance"] as const;
export const PORTFOLIO_WALLET_VALUE_KEY = [...PORTFOLIO_WALLET_KEY, "value"] as const;

export const WRAP_NEAR_CONTRACT = "wrap.near";

/**
 * wrap.near's own unwrap, signed in the owner's wallet: it burns `units` of the signer's wNEAR and sends the same
 * amount of native NEAR back to the signer. `near_withdraw` requires exactly one attached yoctoNEAR, which wrap.near
 * returns with the NEAR.
 */
export function nearClaimTransaction(
  accountId: string,
  units: string,
): {
  signerId: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: { methodName: string; args: Readonly<Record<string, string>>; gas: string; deposit: string };
  }[];
} {
  return {
    signerId: accountId,
    receiverId: WRAP_NEAR_CONTRACT,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "near_withdraw", args: { amount: units }, gas: "30000000000000", deposit: "1" },
      },
    ],
  };
}

export type WalletBalanceView = z.infer<typeof walletBalanceViewSchema>;
export type WalletValueView = z.infer<typeof walletValueViewSchema>;
