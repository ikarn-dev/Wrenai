import { z } from "zod";
import { nearAccountSchema } from "@/shared/agent-budget";
import { positiveTokenUnitsSchema } from "@/shared/token-units";

export const memeEvidenceSchema = z.strictObject({
  profile: z.literal("nearly-raw-v6-lock8"),
  token: nearAccountSchema,
  poolId: z
    .string()
    .max(200)
    .regex(/^[a-z0-9._-]+\|[a-z0-9._-]+\|10000$/),
  createdAt: z.number().int().positive(),
  observedAt: z.number().int().positive(),
  riskCheckedAt: z.number().int().positive(),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  blockHeight: z.number().int().positive(),
  liquidityNearUnits: positiveTokenUnitsSchema,
});
export type MemeEvidence = z.infer<typeof memeEvidenceSchema>;
