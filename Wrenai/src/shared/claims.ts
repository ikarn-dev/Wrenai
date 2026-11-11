import { z } from "zod";
import { instructionAssetSchema } from "./agent-instructions";
import { statusSchema } from "./agents";
import { manualPreviewSchema } from "./manual-trading";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";

export const WNEAR_ASSET_ID = "nep141:wrap.near";
/** The agent reason while a claim runs normally; any other reason during a claim explains a delay. */
export const CLAIMING_REASON = "Stopped. Sending its funds to your wallet.";

const amountSchema = z.strictObject({
  assetId: z.string().max(256),
  symbol: z.string().min(1).max(64),
  /** Null when the token's precision is unknown; the amount then shows in exact base units. */
  decimals: z.number().int().min(0).max(36).nullable(),
  units: positiveTokenUnitsSchema,
});
export type ClaimAmount = z.infer<typeof amountSchema>;

/**
 * One row of the Claims screen: an agent with funds, free private balance or wNEAR already in the wallet.
 * USD figures are display estimates from 1Click reference prices, rounded down; null when any part is unpriced.
 */
export const claimRowSchema = z.strictObject({
  id: z.string().min(1).max(200),
  source: z.enum(["agent", "private", "wallet"]),
  agent: z
    .strictObject({
      id: z.uuid(),
      name: z.string().max(120),
      status: statusSchema,
      revision: z.number().int().positive(),
      /** When the owner's claim started sending its funds to the wallet. */
      claimingSince: z.number().int().nullable(),
      /** Deleted by the owner; its funds wait here until claimed. */
      deleted: z.boolean(),
      /** The token the claim pays out in; null for as held. */
      returnAssetId: z.string().max(256).nullable(),
      openPosition: z.boolean(),
      reason: z.string().max(400),
    })
    .nullable(),
  deposited: z.array(amountSchema).max(20),
  depositedMicroUsd: tokenUnitsSchema.nullable(),
  claimable: z.array(amountSchema).max(20),
  claimableMicroUsd: tokenUnitsSchema.nullable(),
  /** The deposit principal the claimable funds still carry; PnL is measured against it. */
  principalMicroUsd: tokenUnitsSchema.nullable(),
  /** Claimable value minus the deposits it still holds, in micro-USD; signed. */
  pnlMicroUsd: z
    .string()
    .regex(/^-?\d{1,40}$/)
    .nullable(),
  /** When the private balance behind this row was last read from NEAR Intents. */
  observedAt: z.number().int().nullable(),
});
export type ClaimRow = z.infer<typeof claimRowSchema>;

export const receiveOptionSchema = z.strictObject({
  assetId: instructionAssetSchema,
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(36),
});
export type ReceiveOption = z.infer<typeof receiveOptionSchema>;

export const claimRecoverySchema = z.strictObject({
  id: z.uuid(),
  row: claimRowSchema,
  order: manualPreviewSchema,
  confirmedAt: z.number().int().positive(),
  /** Its wNEAR payout can be unwrapped to native NEAR in the owner's wallet. */
  unwrap: z.boolean(),
});
export type ClaimRecovery = z.infer<typeof claimRecoverySchema>;

export const claimsViewSchema = z.strictObject({
  rows: z.array(claimRowSchema).max(100),
  /** Confirmed wallet claims whose provider settlement is still unresolved. */
  recoveries: z.array(claimRecoverySchema).max(20),
  /** Every NEAR token a claim can be paid out in. NEAR itself arrives as wNEAR and is unwrapped in the wallet. */
  receiveOptions: z.array(receiveOptionSchema).max(400),
  notice: z.string().max(200).nullable(),
});
export type ClaimsView = z.infer<typeof claimsViewSchema>;

export const PENDING_CLAIMS_KEY = ["pending-claims"] as const;
