import { z } from "zod";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import { tradeAssetSchema } from "@/shared/trade-preview";
import { WALLET_SWAP_RHEA_WRAP } from "@/shared/wallet-swap";
import { hashSchema } from "../contracts";
import { swapSignalSchema } from "../intents-record";

export const RHEA_DCL = "dclv2.ref-labs.near";
export const NATIVE_GAS_ASSET = "native:near";
// A reviewed per-transaction ceiling from the separately funded native gas balance, not trading inventory.
export const MAX_NATIVE_GAS_UNITS = 5n * 10n ** 22n;
export const DCL_SWAP_GAS = 180000000000000n;
export const rheaQuoteSchema = z.strictObject({
  poolId: z.string().min(5).max(200),
  input: tradeAssetSchema,
  output: tradeAssetSchema,
  inputUnits: positiveTokenUnitsSchema,
  outputUnits: positiveTokenUnitsSchema,
  minimumOutputUnits: positiveTokenUnitsSchema,
  inputMicroUsd: positiveTokenUnitsSchema,
  outputMicroUsd: positiveTokenUnitsSchema.nullable().optional(),
  blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  observedAt: z.number().int().positive().safe(),
  expiresAt: z.number().int().positive().safe(),
  slippageBps: z.number().int().min(1).max(500),
});
export const rheaPreparedSchema = z.strictObject({
  format: z.literal(1),
  accountId: z.string().regex(/^[a-f0-9]{64}$/),
  rootId: z.uuid(),
  quote: rheaQuoteSchema,
  quoteHash: hashSchema,
  registrationDeposit: positiveTokenUnitsSchema.nullable(),
  signal: swapSignalSchema.optional(),
  payloadHash: hashSchema,
});
export type RheaPrepared = z.infer<typeof rheaPreparedSchema>;

export function rheaSwapCall(prepared: RheaPrepared): {
  receiverId: string;
  methodName: string;
  args: { receiver_id: string; amount: string; msg: string };
  gas: string;
  deposit: string;
} {
  const q = prepared.quote;
  const nativeOutput = q.output.assetId === NATIVE_GAS_ASSET;
  return {
    receiverId: q.input.assetId.slice(7),
    methodName: "ft_transfer_call",
    args: {
      receiver_id: RHEA_DCL,
      amount: q.inputUnits,
      msg: JSON.stringify({
        Swap: {
          pool_ids: [q.poolId],
          output_token: nativeOutput ? WALLET_SWAP_RHEA_WRAP : q.output.assetId.slice(7),
          min_output_amount: q.minimumOutputUnits,
          ...(nativeOutput ? { skip_unwrap_near: false } : {}),
        },
      }),
    },
    gas: DCL_SWAP_GAS.toString(),
    deposit: "1",
  };
}
