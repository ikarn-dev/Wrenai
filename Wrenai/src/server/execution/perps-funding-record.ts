import { z } from "zod";
import { preparedOrderSchema } from "./intents-record";
export const fundingRecordSchema = z.strictObject({
  format: z.literal(1),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  order: preparedOrderSchema,
});
export type PerpsFundingRecord = z.infer<typeof fundingRecordSchema>;
