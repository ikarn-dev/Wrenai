import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { memeEvidenceSchema } from "@/server/squint/near-profile-contracts";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { tradeAssetSchema } from "@/shared/trade-preview";
import { instructionStateSchema } from "./instruction-state";

export type MemeInstruction = Extract<AgentInstruction, { kind: "meme_hunter" }>;
export const memePositionSchema = z.strictObject({
  asset: tradeAssetSchema,
  native: z.literal(true).optional(),
  assetHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: memeEvidenceSchema,
  spot: instructionStateSchema,
});
export const memeStateSchema = z
  .strictObject({
    format: z.literal(6),
    kind: z.literal("meme_hunter"),
    strategyHash: z.string().regex(/^[a-f0-9]{64}$/),
    positions: z.array(memePositionSchema).max(20),
    seen: z.array(z.string().max(180)).max(4096),
    pendingAssetId: z.string().max(180).nullable(),
    pendingActionId: z.uuid().nullable(),
    lastActionId: z.uuid().nullable(),
    lastDiscoveryAt: z.number().int().nonnegative().nullable(),
    discoveryCursor: z.string().min(1).max(180).nullable().default(null),
  })
  .superRefine((state, ctx) => {
    if (
      new Set(state.positions.map((p) => p.asset.assetId)).size !== state.positions.length ||
      new Set(state.seen).size !== state.seen.length ||
      state.positions.some(
        (p) => p.spot.kind !== "spot_trader" || p.asset.assetId !== `nep141:${p.evidence.token}`,
      ) ||
      (state.pendingAssetId !== null &&
        !state.positions.some((p) => p.asset.assetId === state.pendingAssetId)) ||
      (state.pendingActionId !== null && state.pendingAssetId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "The hunter state has inconsistent token identities or pending ownership.",
      });
    }
  });
export type MemeState = z.infer<typeof memeStateSchema>;
export type MemePosition = z.infer<typeof memePositionSchema>;
export function initialMemeState(strategyHash: string): MemeState {
  return {
    format: 6,
    kind: "meme_hunter",
    strategyHash,
    positions: [],
    seen: [],
    pendingAssetId: null,
    pendingActionId: null,
    lastActionId: null,
    lastDiscoveryAt: null,
    discoveryCursor: null,
  };
}
export function memeSpotInstruction(
  instruction: MemeInstruction,
  assetId: string,
): Extract<AgentInstruction, { kind: "spot_trader" }> {
  return {
    format: 2,
    kind: "spot_trader",
    payAssetId: instruction.payAssetId,
    buyAssetId: assetId,
    amountUnits: instruction.amountUnits,
    side: "buy",
    entry: { type: "market" },
    expiresAt: instruction.expiresAt,
    onExpiry: instruction.onExpiry,
    priceUnit: instruction.priceUnit,
    exits: instruction.exits,
  };
}
export function memeSlot(position: MemePosition): string | null {
  return position.spot.pendingSlot === null ? null : `${position.asset.assetId}:${position.spot.pendingSlot}`;
}
export function replaceMemePosition(state: MemeState, position: MemePosition): MemeState {
  if (!state.positions.some((p) => p.asset.assetId === position.asset.assetId)) {
    throw new ExecutionError("conflict", "The hunter does not own this candidate.");
  }
  return {
    ...state,
    positions: state.positions.map((p) => (p.asset.assetId === position.asset.assetId ? position : p)),
  };
}
