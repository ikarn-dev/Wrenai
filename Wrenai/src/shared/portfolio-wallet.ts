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

export type WalletBalanceView = z.infer<typeof walletBalanceViewSchema>;
export type WalletValueView = z.infer<typeof walletValueViewSchema>;
