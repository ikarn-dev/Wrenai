import { z } from "zod";
import { nearAccountSchema, walletAssetSchema } from "./agent-budget";
import { positiveTokenUnitsSchema } from "./token-units";

export const NATIVE_FUNDING_GAS = "100000000000000000000000";
export const nativeFundingRequestSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid().optional(),
  assetId: walletAssetSchema,
  amount: z.string().regex(/^(?:0|[1-9]\d{0,30})(?:\.\d{1,36})?$/),
});
export const nativeFundingSnapshotSchema = z.strictObject({
  id: z.uuid(),
  userId: z.string().min(1),
  accountId: nearAccountSchema,
  subjectId: z.uuid(),
  agentId: z.uuid().nullable(),
  rootId: z.uuid(),
  nativeAccountId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceAssetId: walletAssetSchema,
  assetId: z.string().regex(/^nep141:[a-z0-9._-]+$/),
  units: positiveTokenUnitsSchema,
  principalMicroUsd: positiveTokenUnitsSchema.optional(),
  decimals: z.number().int().min(0).max(36),
  tokenSymbol: z.string().max(80),
  gasUnits: z.literal(NATIVE_FUNDING_GAS),
  registrationUnits: positiveTokenUnitsSchema,
});
export type NativeFundingSnapshot = z.infer<typeof nativeFundingSnapshotSchema>;
export interface NativeFundingView {
  readonly id: string;
  readonly state: "prepared" | "gas_pending" | "gas_confirmed" | "token_pending" | "complete" | "cancelled";
  readonly snapshot: NativeFundingSnapshot;
  readonly snapshotHash: string;
  readonly expiresAt: number;
  readonly gasHash: string | null;
  readonly tokenHash: string | null;
}
export const nativeFundingCommandSchema = z.strictObject({
  id: z.uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["gas", "token"]),
  transactionHash: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
    .optional(),
});

export function nativeGasTransaction(snapshot: NativeFundingSnapshot): {
  signerId: string;
  receiverId: string;
  actions: { type: "Transfer"; params: { deposit: string } }[];
} {
  return {
    signerId: snapshot.accountId,
    receiverId: snapshot.nativeAccountId,
    actions: [{ type: "Transfer", params: { deposit: snapshot.gasUnits } }],
  };
}
export function nativeDepositTransaction(snapshot: NativeFundingSnapshot): {
  signerId: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: {
      methodName: string;
      args: Readonly<Record<string, string | boolean>>;
      gas: string;
      deposit: string;
    };
  }[];
} {
  return {
    signerId: snapshot.accountId,
    receiverId: snapshot.assetId.slice(7),
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: snapshot.nativeAccountId, registration_only: true },
          gas: "30000000000000",
          deposit: snapshot.registrationUnits,
        },
      },
      ...(snapshot.sourceAssetId === "native:near"
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
          methodName: "ft_transfer",
          args: {
            receiver_id: snapshot.nativeAccountId,
            amount: snapshot.units,
            memo: `wrenai-native:${snapshot.id}`,
          },
          gas: "30000000000000",
          deposit: "1",
        },
      },
    ],
  };
}
