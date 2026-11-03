import { z } from "zod";

export const perpsReturnInputSchema = z.strictObject({
  agentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  requestId: z.uuid(),
});
export const perpsReturnConfirmationSchema = z.strictObject({
  previewId: z.uuid(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface PerpsReturnPreview {
  readonly id: string;
  readonly agentId: string;
  readonly evidenceHash: string;
  readonly expiresAt: number;
  readonly debitUnits: string;
  readonly networkFeeUnits: string;
  readonly receiveUnits: string;
  readonly receiveSymbol: string;
  readonly receiveDecimals: number;
  readonly destinationAccount: string;
  readonly quotedReceiveUnits: string;
}
export const hlUsdSendSchema = z.strictObject({
  type: z.literal("usdSend"),
  signatureChainId: z.literal("0x66eee"),
  hyperliquidChain: z.literal("Mainnet"),
  destination: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,20})(?:\.\d{1,6})?$/),
  time: z.number().int().positive().safe(),
});
export type HlUsdSend = z.infer<typeof hlUsdSendSchema>;
