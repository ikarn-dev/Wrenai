import { z } from "zod";
import { nearAccountSchema, walletAssetSchema } from "./agent-budget";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";
import { WALLET_SWAP_NATIVE_OUTPUT } from "./wallet-swap";

const paymentRoute = z.enum(["private", "wallet"]);
export const paymentAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,38})(?:\.\d{1,255})?$/)
  .refine((amount) => /[1-9]/.test(amount), "Enter a positive payment amount.");
export const paymentOfferSchema = z.strictObject({
  id: z.uuid(),
  recipient: nearAccountSchema,
  assetId: walletAssetSchema,
  symbol: z.string().min(1).max(80),
  amount: paymentAmountSchema,
  routes: z.array(paymentRoute).min(1).max(2),
});
export type PaymentOffer = z.infer<typeof paymentOfferSchema>;

export const walletPaymentRequestSchema = z.strictObject({
  requestId: z.uuid(),
  recipient: nearAccountSchema,
  assetId: walletAssetSchema,
  amount: paymentAmountSchema,
});
export const walletPaymentQuoteSchema = z.strictObject({
  kind: z.literal("payment"),
  request: walletPaymentRequestSchema,
  accountId: nearAccountSchema,
  symbol: z.string().min(1).max(80),
  units: positiveTokenUnitsSchema,
  registrationUnits: tokenUnitsSchema,
  registerRecipient: z.boolean(),
});
export type WalletPaymentQuote = z.infer<typeof walletPaymentQuoteSchema>;
export const walletPaymentViewSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(["quoted", "signing", "submitted", "settled", "failed", "cancelled", "expired"]),
  expiresAt: z.number().int().positive(),
  transactionHash: z.string().nullable(),
  quote: walletPaymentQuoteSchema,
});
export type WalletPaymentView = z.infer<typeof walletPaymentViewSchema>;

type WalletAction =
  | { type: "Transfer"; params: { deposit: string } }
  | {
      type: "FunctionCall";
      params: {
        methodName: string;
        args: Record<string, string | boolean>;
        gas: string;
        deposit: string;
      };
    };

export function walletPaymentTransaction(quote: WalletPaymentQuote): {
  signerId: string;
  receiverId: string;
  actions: WalletAction[];
} {
  const { accountId, request, units, registrationUnits } = quote;
  if (request.assetId === WALLET_SWAP_NATIVE_OUTPUT) {
    return {
      signerId: accountId,
      receiverId: request.recipient,
      actions: [{ type: "Transfer", params: { deposit: units } }],
    };
  }
  const actions: WalletAction[] = [];
  if (quote.registerRecipient) {
    actions.push({
      type: "FunctionCall",
      params: {
        methodName: "storage_deposit",
        args: { account_id: request.recipient, registration_only: true },
        gas: "30000000000000",
        deposit: registrationUnits,
      },
    });
  }
  actions.push({
    type: "FunctionCall",
    params: {
      methodName: "ft_transfer",
      args: { receiver_id: request.recipient, amount: units },
      gas: "30000000000000",
      deposit: "1",
    },
  });
  return { signerId: accountId, receiverId: request.assetId.slice("nep141:".length), actions };
}
