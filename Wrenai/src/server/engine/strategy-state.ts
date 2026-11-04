import { z } from "zod";
import { copyStateSchema } from "./copy";
import { instructionStateSchema } from "./instruction-state";
import { memeStateSchema } from "./meme-state";
import { perpsStateSchema } from "./perps-state";
import { triggerStateSchema } from "./trigger";

// Archived format only; the removed agent has no planner, provider reads or activation path.
const retiredWatchState = z.strictObject({
  format: z.literal(4),
  kind: z.literal("whale_tracker"),
  phase: z.enum(["watching", "completed"]),
  cursors: z
    .array(
      z.strictObject({
        account: z.string().min(2).max(64),
        stream: z.enum(["transactions", "tokens"]),
        from: z.number().int().positive(),
        snapshotAt: z.number().int().positive(),
        next: z.string().min(1).max(8192).nullable(),
        lastAlertAt: z.number().int().nonnegative(),
      }),
    )
    .max(40),
});

export const runtimeStrategyStateSchema = z.union([
  triggerStateSchema,
  copyStateSchema,
  instructionStateSchema,
  retiredWatchState,
  perpsStateSchema,
  memeStateSchema,
]);
export type RuntimeStrategyState = z.infer<typeof runtimeStrategyStateSchema>;

export function hasOpenTriggerPosition(raw: string): boolean {
  const state = runtimeStrategyStateSchema.parse(JSON.parse(raw));
  if (state.format === 6) {
    return state.positions.some((position) => position.spot.quantityUnits !== "0");
  }
  return (state.format === 1 || state.format === 3 || state.format === 5) && state.phase === "holding";
}
