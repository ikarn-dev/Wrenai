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
