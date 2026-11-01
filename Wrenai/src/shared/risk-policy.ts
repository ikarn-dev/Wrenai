import { z } from "zod";
import { usdInputSchema } from "./agents";

// Asset choices belong to each reviewed strategy, not to account Settings.
export const userRiskPolicySchema = z.strictObject({
  dailyCapUsd: usdInputSchema,
});

export const saveUserRiskPolicySchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
  policy: userRiskPolicySchema,
});

export type UserRiskPolicy = z.infer<typeof userRiskPolicySchema>;
export interface UserRiskPolicyRecord {
  readonly revision: number;
  readonly policy: UserRiskPolicy;
  readonly updatedAt: number;
}
