import { z } from "zod";

const cursor = z.strictObject({
  account: z.string().min(2).max(64),
  stream: z.enum(["transactions", "tokens"]),
  from: z.number().int().positive(),
  snapshotAt: z.number().int().positive(),
  next: z.string().min(1).max(8192).nullable(),
  lastAlertAt: z.number().int().nonnegative(),
});
export const whaleStateSchema = z.strictObject({
  format: z.literal(4),
  kind: z.literal("whale_tracker"),
  phase: z.enum(["watching", "completed"]),
  cursors: z.array(cursor).max(40),
});
export type WhaleState = z.infer<typeof whaleStateSchema>;
