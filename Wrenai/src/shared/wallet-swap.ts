import { z } from "zod";
import { nearAccountSchema, walletAssetSchema } from "./agent-budget";
import { manualPaymentIntentSchema } from "./manual-trading";
import { WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_RHEA_POOL, WALLET_SWAP_USDC } from "./swap-assets";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";
import { tradeAssetSchema } from "./trade-preview";
import { tradeSizeSchema } from "./trade-size";

/** 1Click's asset ID for NEAR, including native deposits. */
export const WALLET_SWAP_INPUT = "nep141:wrap.near";
export { WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_RHEA_POOL, WALLET_SWAP_USDC };
export const WALLET_SWAP_RHEA_DCL = "dclv2.ref-labs.near";
export const WALLET_SWAP_RHEA_WRAP = "wrap.near";
export const WALLET_SWAP_RHEA_GAS = "180000000000000";
/** wrap.near's storage registration for a new account (storage_balance_bounds.min), in yoctoNEAR. */
export const WRAP_STORAGE_YOCTO = "1250000000000000000000";
const GAS = "30000000000000";

export const walletSwapRequestSchema = z.strictObject({
  requestId: z.uuid(),
  amount: tradeSizeSchema,
  inputAssetId: walletAssetSchema.optional(),
  outputAssetId: z.union([
    z.literal(WALLET_SWAP_NATIVE_OUTPUT),
    z.string().regex(/^nep141:[a-z0-9._-]{2,64}$/),
  ]),
  slippageBps: z.number().int().min(1).max(500),
  maximumFeeBps: z.number().int().min(0).max(2000),
});
export type WalletSwapRequest = z.infer<typeof walletSwapRequestSchema>;

const privateTopUpSchema = z.strictObject({
  intent: manualPaymentIntentSchema,
  maximumDebitUnits: positiveTokenUnitsSchema,
  requestDeadline: z.iso.datetime(),
  providerQuoteJson: z.string().min(1).max(28_000),
  quotedAt: z.iso.datetime(),
  signingPublicKey: z.string().min(1).max(128),
  reviewRequired: z.literal(true).optional(),
});

export const walletSwapQuoteSchema = z
  .strictObject({
    request: walletSwapRequestSchema,
    accountId: nearAccountSchema,
    depositAddress: nearAccountSchema.nullable(),
    // Older saved quotes were funded with a wrap.near batch. Keep their original proof format.
    depositKind: z.enum(["native_near", "nep141", "rhea_native"]).optional(),
    rheaPoolId: z.string().min(5).max(200).optional(),
    rheaBlockHash: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
      .optional(),
    pairVerified: z.literal(true).optional(),
    storageDepositUnits: tokenUnitsSchema.optional(),
    privateTopUp: privateTopUpSchema.optional(),
    input: tradeAssetSchema,
    output: tradeAssetSchema,
    inputUnits: positiveTokenUnitsSchema,
    outputUnits: positiveTokenUnitsSchema,
    minimumOutputUnits: positiveTokenUnitsSchema,
    appFeeBps: z.number().int().min(0).max(2000),
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((quote, context) => {
    const topUp = quote.privateTopUp;
    if (
      topUp &&
      (quote.depositKind !== "nep141" ||
        quote.request.inputAssetId !== topUp.intent.assetId ||
        quote.request.outputAssetId !== topUp.intent.assetId ||
        quote.input.assetId !== topUp.intent.assetId ||
        quote.output.assetId !== topUp.intent.assetId ||
        BigInt(quote.minimumOutputUnits) > BigInt(topUp.maximumDebitUnits))
    ) {
      context.addIssue({ code: "custom", message: "A payment top-up must use the same token." });
    }
    if (quote.depositKind === "rhea_native") {
      if (
        quote.depositAddress !== null ||
        quote.request.outputAssetId !== WALLET_SWAP_NATIVE_OUTPUT ||
        quote.request.inputAssetId !== WALLET_SWAP_USDC ||
        quote.input.assetId !== WALLET_SWAP_USDC ||
        quote.input.contractAddress !== WALLET_SWAP_USDC.slice("nep141:".length) ||
        quote.input.decimals !== 6 ||
        quote.input.tokenSymbol !== "USDC" ||
        quote.output.assetId !== WALLET_SWAP_NATIVE_OUTPUT ||
        quote.output.contractAddress !== null ||
        quote.output.decimals !== 24 ||
        quote.output.tokenSymbol !== "NEAR" ||
        quote.rheaPoolId !== WALLET_SWAP_RHEA_POOL ||
        !quote.rheaBlockHash ||
        quote.pairVerified !== true ||
        quote.storageDepositUnits !== undefined ||
        quote.appFeeBps !== 0
      ) {
        context.addIssue({ code: "custom", message: "Invalid RHEA native quote." });
      }
    } else if (
      quote.depositAddress === null ||
      quote.request.outputAssetId === WALLET_SWAP_NATIVE_OUTPUT ||
      quote.rheaPoolId !== undefined ||
      quote.rheaBlockHash !== undefined
    ) {
      context.addIssue({ code: "custom", message: "Invalid 1Click quote." });
    }
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
export const walletSwapViewSchema = z.strictObject({
  id: z.uuid(),
  /** "expired" is shown, never stored: an unsigned quote past its deadline. */
  state: z.union([walletSwapStateSchema, z.literal("expired")]),
  quote: walletSwapQuoteSchema,
  transactionHash: z.string().max(100).nullable(),
  receivedUnits: tokenUnitsSchema.nullable(),
  spentUnits: tokenUnitsSchema.nullable().optional(),
  expiresAt: z.number().int(),
});
export type WalletSwapView = z.infer<typeof walletSwapViewSchema>;
export const paymentTopUpViewSchema = walletSwapViewSchema.extend({
  maximumDebitUnits: positiveTokenUnitsSchema,
  reviewRequired: z.boolean(),
});
export type PaymentTopUpView = z.infer<typeof paymentTopUpViewSchema>;

export const walletSwapIdSchema = z.strictObject({ id: z.uuid() });
export const walletSwapProofSchema = walletSwapIdSchema.extend({
  transactionHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
});
export const walletSwapSubmissionSchema = walletSwapProofSchema.extend({
  fromRecovery: z.literal(true).optional(),
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

interface WalletTransfer {
  readonly type: "Transfer";
  readonly params: { readonly deposit: string };
}

export function walletSwapTransaction(quote: WalletSwapQuote): {
  readonly signerId: string;
  readonly receiverId: string;
  readonly actions: readonly (WalletCall | WalletTransfer)[];
} {
  walletSwapQuoteSchema.parse(quote);
  if (quote.depositKind === "rhea_native") {
    return {
      signerId: quote.accountId,
      receiverId: WALLET_SWAP_USDC.slice("nep141:".length),
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: {
              receiver_id: WALLET_SWAP_RHEA_DCL,
              amount: quote.inputUnits,
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [WALLET_SWAP_RHEA_POOL],
                  output_token: WALLET_SWAP_RHEA_WRAP,
                  min_output_amount: quote.minimumOutputUnits,
                  skip_unwrap_near: false,
                },
              }),
            },
            gas: WALLET_SWAP_RHEA_GAS,
            deposit: "1",
          },
        },
      ],
    };
  }
  if (quote.depositKind === "native_near") {
    return {
      signerId: quote.accountId,
      receiverId: nearAccountSchema.parse(quote.depositAddress),
      actions: [{ type: "Transfer", params: { deposit: quote.inputUnits } }],
    };
  }
  if (quote.depositKind === "nep141") {
    const contract = nearAccountSchema.parse(quote.input.assetId.slice(7));
    const storage = tokenUnitsSchema.parse(quote.storageDepositUnits);
    return {
      signerId: quote.accountId,
      receiverId: contract,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "storage_deposit",
            args: { account_id: nearAccountSchema.parse(quote.depositAddress), registration_only: true },
            gas: GAS,
            deposit: storage,
          },
        },
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer",
            args: { receiver_id: nearAccountSchema.parse(quote.depositAddress), amount: quote.inputUnits },
            gas: GAS,
            deposit: "1",
          },
        },
      ],
    };
  }
  return {
    signerId: quote.accountId,
    receiverId: "wrap.near",
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: nearAccountSchema.parse(quote.depositAddress), registration_only: true },
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
          args: { receiver_id: nearAccountSchema.parse(quote.depositAddress), amount: quote.inputUnits },
          gas: GAS,
          deposit: "1",
        },
      },
    ],
  };
}
