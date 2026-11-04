import { z } from "zod";
import { nearAccountSchema, walletAssetSchema } from "./agent-budget";
import { positiveTokenUnitsSchema } from "./token-units";

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
});
export type WalletFundingSnapshot = z.infer<typeof walletFundingSnapshotSchema>;
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
]);
export interface WalletFundingView {
  readonly id: string;
  readonly state: z.infer<typeof walletFundingStateSchema>;
  readonly snapshot: WalletFundingSnapshot;
  readonly transactionHash: string | null;
  readonly actionId: string | null;
  readonly expiresAt: number;
}

/** One wallet transaction: wrap native NEAR if necessary, then deposit the exact FT into the owner's Verifier balance. */
export function walletFundingTransaction(snapshot: WalletFundingSnapshot): {
  readonly signerId: string;
  readonly receiverId: string;
  readonly actions: readonly {
    readonly type: "FunctionCall";
    readonly params: {
      readonly methodName: string;
      readonly args: Readonly<Record<string, string>>;
      readonly gas: string;
      readonly deposit: string;
    };
  }[];
} {
  walletFundingSnapshotSchema.parse(snapshot);
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
