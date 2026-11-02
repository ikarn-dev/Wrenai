import { z } from "zod";
import { usdInputSchema } from "./agents";

export const agentFundingSchema = z.strictObject({
  requestId: z.uuid(),
  previewId: z.uuid(),
  agentCapitalUsd: usdInputSchema,
});
