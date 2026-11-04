import { z } from "zod";
import { nearAccountSchema } from "./agent-budget";
import { tradingDecimalSchema } from "./manual-trading";
import { positiveTokenUnitsSchema } from "./token-units";
import { tradeAssetSchema } from "./trade-preview";

/** Wallet swaps spend native NEAR, wrapped to wNEAR in the same transaction (1Click's NEAR origin asset). */
export const WALLET_SWAP_INPUT = "nep141:wrap.near";
/** wrap.near's storage registration for a new account (storage_balance_bounds.min), in yoctoNEAR. */
export const WRAP_STORAGE_YOCTO = "1250000000000000000000";
const GAS = "30000000000000";

export const walletSwapRequestSchema = z.strictObject({
  requestId: z.uuid(),
  amount: tradingDecimalSchema,
  outputAssetId: z.string().regex(/^nep141:[a-z0-9._-]{2,64}$/),
  slippageBps: z.number().int().min(1).max(500),
  maximumFeeBps: z.number().int().min(0).max(2000),
});
export type WalletSwapRequest = z.infer<typeof walletSwapRequestSchema>;

export const walletSwapQuoteSchema = z.strictObject({
  request: walletSwapRequestSchema,
  accountId: nearAccountSchema,
  depositAddress: nearAccountSchema,
  input: tradeAssetSchema,
  output: tradeAssetSchema,
  inputUnits: positiveTokenUnitsSchema,
  outputUnits: positiveTokenUnitsSchema,
  minimumOutputUnits: positiveTokenUnitsSchema,
  appFeeBps: z.number().int().min(0).max(2000),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WalletSwapQuote = z.infer<typeof walletSwapQuoteSchema>;

export const walletSwapStateSchema = z.enum([
  "quoted",
  "signing",
  "submitted",
  "settled",
  "refunded",
  "failed",
  "cancelled",
]);
export interface WalletSwapView {
  readonly id: string;
  /** "expired" is shown, never stored: an unsigned quote past its deadline. */
  readonly state: z.infer<typeof walletSwapStateSchema> | "expired";
  readonly quote: WalletSwapQuote;
  readonly transactionHash: string | null;
  readonly receivedUnits: string | null;
  readonly expiresAt: number;
}

export const walletSwapIdSchema = z.strictObject({ id: z.uuid() });
export const walletSwapProofSchema = walletSwapIdSchema.extend({
  transactionHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
});

interface WalletCall {
  readonly type: "FunctionCall";
  readonly params: {
    readonly methodName: string;
    readonly args: Readonly<Record<string, string | boolean>>;
    readonly gas: string;
    readonly deposit: string;
  };
}

/**
 * The one transaction the wallet signs, all on wrap.near: register 1Click's deposit address, wrap the exact NEAR,
 * then send that wNEAR to the deposit address. 1Click swaps on arrival and pays the output to the same wallet.
 */
export function walletSwapTransaction(quote: WalletSwapQuote): {
  readonly signerId: string;
  readonly receiverId: "wrap.near";
  readonly actions: readonly WalletCall[];
} {
  walletSwapQuoteSchema.parse(quote);
  return {
    signerId: quote.accountId,
    receiverId: "wrap.near",
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: quote.depositAddress, registration_only: true },
          gas: GAS,
          deposit: WRAP_STORAGE_YOCTO,
        },
      },
      {
        type: "FunctionCall",
        params: { methodName: "near_deposit", args: {}, gas: GAS, deposit: quote.inputUnits },
      },
      {
        type: "FunctionCall",
        params: {
          methodName: "ft_transfer",
          args: { receiver_id: quote.depositAddress, amount: quote.inputUnits },
          gas: GAS,
          deposit: "1",
        },
      },
    ],
  };
}
