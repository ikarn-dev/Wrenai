import { z } from "zod";
import { formatUnits } from "./money";
import { parseTokenAmount, positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";

export const nearAccountSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const walletAssetSchema = z
  .string()
  .max(71)
  .refine(
    (value) =>
      value === "native:near" ||
      (value.startsWith("nep141:") && nearAccountSchema.safeParse(value.slice(7)).success),
    "Choose native NEAR or a valid NEAR token contract.",
  );
export const agentBudgetInputSchema = z.strictObject({
  assetId: walletAssetSchema,
  amount: z
    .string()
    .trim()
    .min(1)
    .max(115)
    .regex(/^(?:0|[1-9]\d{0,77})(?:\.\d{1,36})?$/),
});
export type AgentBudgetInput = z.infer<typeof agentBudgetInputSchema>;
export const walletHoldingSchema = z.strictObject({
  assetId: walletAssetSchema,
  symbol: z.string().trim().min(1).max(64),
  decimals: z.number().int().min(0).max(36),
  balanceUnits: tokenUnitsSchema,
  spendableUnits: tokenUnitsSchema,
  observedAt: z.number().int().positive(),
  blockHeight: z.number().int().positive(),
});
export type WalletHolding = z.infer<typeof walletHoldingSchema>;
export const agentTokenBudgetSchema = z.strictObject({
  source: z.literal("near_wallet"),
  accountId: nearAccountSchema,
  assetId: walletAssetSchema,
  symbol: z.string().trim().min(1).max(64),
  decimals: z.number().int().min(0).max(36),
  units: positiveTokenUnitsSchema,
  observedAt: z.number().int().positive(),
  blockHeight: z.number().int().positive(),
  walletReservedUnits: tokenUnitsSchema.optional(),
});
export type AgentTokenBudget = z.infer<typeof agentTokenBudgetSchema>;
export interface WalletBudgetToken extends WalletHolding {
  readonly allocatedUnits: string;
  readonly availableUnits: string;
  readonly deficitUnits: string;
}
export interface WalletBudgetView {
  readonly accountId: string;
  readonly tokens: readonly WalletBudgetToken[];
  readonly note: string;
  /** Funded venue lots are already outside this wallet. Never subtract them from it again. */
  readonly funded: readonly { readonly scope: string; readonly assetId: string; readonly units: string }[];
}
export const BUDGET_BALANCE_MAX_AGE_MS = 15_000;

/** Exact display and editable amounts; no rounding, scientific notation or USD price dependency. */
export function budgetTokenAmount(units: string, decimals: number): string {
  return formatUnits(BigInt(units), { decimals, fractionDigits: decimals })
    .replaceAll(",", "")
    .replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export function walletBudgetAvailability(holding: WalletHolding, allocated: bigint): WalletBudgetToken {
  const spendable = BigInt(holding.spendableUnits);
  return {
    ...holding,
    allocatedUnits: allocated.toString(),
    availableUnits: (spendable > allocated ? spendable - allocated : 0n).toString(),
    deficitUnits: (allocated > spendable ? allocated - spendable : 0n).toString(),
  };
}

export function checkedWalletBudget(
  accountId: string,
  input: AgentBudgetInput,
  holding: WalletHolding,
  allocated: bigint,
  now: number,
  previousUnits = 0n,
): AgentTokenBudget {
  if (
    holding.assetId !== input.assetId ||
    holding.observedAt > now ||
    now - holding.observedAt >= BUDGET_BALANCE_MAX_AGE_MS
  ) {
    throw new RangeError("The wallet balance expired. Refresh and try again.");
  }
  const units = parseTokenAmount(input.amount, holding.decimals);
  if (units + allocated > BigInt(holding.spendableUnits) && units > previousUnits) {
    throw new RangeError("This amount exceeds the wallet funds available after other agent allocations.");
  }
  return agentTokenBudgetSchema.parse({
    source: "near_wallet",
    accountId,
    assetId: holding.assetId,
    symbol: holding.symbol,
    decimals: holding.decimals,
    units: units.toString(),
    observedAt: holding.observedAt,
    blockHeight: holding.blockHeight,
  });
}
