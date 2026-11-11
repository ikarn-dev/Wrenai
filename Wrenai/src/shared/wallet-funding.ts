import { z } from "zod";
import { agentTokenBudgetSchema, nearAccountSchema, walletAssetSchema } from "./agent-budget";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";

export const walletFundingSnapshotSchema = z.strictObject({
  fundingId: z.uuid(),
  accountId: nearAccountSchema,
  walletAssetId: walletAssetSchema,
  assetId: z.string().regex(/^nep141:[a-z0-9._-]+$/),
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(36),
  units: positiveTokenUnitsSchema,
  minimumPrivateUnits: positiveTokenUnitsSchema,
  principalMicroUsd: positiveTokenUnitsSchema,
  maximumSlippageBps: z.number().int().min(1).max(500),
  maximumProviderFeeBps: z.number().int().min(0).max(2000),
  // Native NEAR: one plain transfer to this 1Click deposit address, delivered straight to the private balance.
  // Older reviews have neither field and keep the wrap-and-deposit route.
  depositAddress: nearAccountSchema.optional(),
  requestDeadline: z.iso.datetime().optional(),
});
export type WalletFundingSnapshot = z.infer<typeof walletFundingSnapshotSchema>;
/** True when the deposit is one native NEAR transfer that 1Click delivers to the private balance. */
export function directNativeFunding(
  snapshot: WalletFundingSnapshot,
): snapshot is WalletFundingSnapshot & { readonly depositAddress: string; readonly requestDeadline: string } {
  return (
    snapshot.walletAssetId === "native:near" &&
    snapshot.depositAddress !== undefined &&
    snapshot.requestDeadline !== undefined
  );
}
export const fundingIdInputSchema = z.strictObject({ fundingId: z.uuid() });
export const fundingTransactionInputSchema = fundingIdInputSchema.extend({
  transactionHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
});
export const walletFundingStateSchema = z.enum([
  "prepared",
  "wallet_pending",
  "deposited",
  "converting",
  "complete",
  "abandoned",
]);
export const walletFundingViewSchema = z.strictObject({
  id: z.string(),
  state: walletFundingStateSchema,
  snapshot: walletFundingSnapshotSchema,
  transactionHash: z.string().nullable(),
  actionId: z.string().nullable(),
  expiresAt: z.number().int(),
});
export type WalletFundingView = z.infer<typeof walletFundingViewSchema>;

export const agentFundingStateSchema = z.strictObject({
  authorized: z.boolean(),
  budget: agentTokenBudgetSchema.nullable(),
  funding: walletFundingViewSchema.nullable(),
  allocatedPrivateUnits: tokenUnitsSchema,
  allocatedPublicUnits: tokenUnitsSchema,
});
export type AgentFundingState = z.infer<typeof agentFundingStateSchema>;

export interface WalletFundingCall {
  readonly type: "FunctionCall";
  readonly params: {
    readonly methodName: string;
    readonly args: Readonly<Record<string, string>>;
    readonly gas: string;
    readonly deposit: string;
  };
}
export interface WalletFundingTransfer {
  readonly type: "Transfer";
  readonly params: { readonly deposit: string };
}
/**
 * One wallet transaction. Native NEAR is one plain transfer to the 1Click deposit address: no wNEAR, no second
 * asset in the wallet. A token is deposited as-is into the owner's Intents balance.
 */
export function walletFundingTransaction(snapshot: WalletFundingSnapshot): {
  readonly signerId: string;
  readonly receiverId: string;
  readonly actions: readonly (WalletFundingCall | WalletFundingTransfer)[];
} {
  walletFundingSnapshotSchema.parse(snapshot);
  if (directNativeFunding(snapshot)) {
    return {
      signerId: snapshot.accountId,
      receiverId: snapshot.depositAddress,
      actions: [{ type: "Transfer", params: { deposit: snapshot.units } }],
    };
  }
  const contract = nearAccountSchema.parse(snapshot.assetId.slice(7));
  if (
    snapshot.walletAssetId === "native:near"
      ? contract !== "wrap.near" || snapshot.decimals !== 24
      : snapshot.walletAssetId !== snapshot.assetId
  ) {
    throw new RangeError("The wallet funding token differs from its reviewed route.");
  }
  return {
    signerId: snapshot.accountId,
    receiverId: contract,
    actions: [
      ...(snapshot.walletAssetId === "native:near"
        ? [
            {
              type: "FunctionCall" as const,
              params: {
                methodName: "near_deposit",
                args: {},
                gas: "30000000000000",
                deposit: snapshot.units,
              },
            },
          ]
        : []),
      {
        type: "FunctionCall",
        params: {
          methodName: "ft_transfer_call",
          args: {
            receiver_id: "intents.near",
            amount: snapshot.units,
            msg: snapshot.accountId,
            memo: `Wrenai funding ${snapshot.fundingId}`,
          },
          gas: "100000000000000",
          deposit: "1",
        },
      },
    ],
  };
}
