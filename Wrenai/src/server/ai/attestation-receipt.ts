import { z } from "zod";
import { inferenceModelSchema } from "@/shared/ai-models";

export const attestationReceiptSchema = z.strictObject({
  model: inferenceModelSchema,
  completionId: z.string().min(1),
  signatureKind: z.literal("provider_tee"),
  verifiedAt: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceJson: z.string().min(1),
});
export type AttestationReceipt = z.infer<typeof attestationReceiptSchema>;
