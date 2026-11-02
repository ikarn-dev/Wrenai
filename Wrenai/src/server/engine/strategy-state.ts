import { z } from "zod";
import { copyStateSchema } from "./copy";
import { instructionStateSchema } from "./instruction-state";
import { triggerStateSchema } from "./trigger";
import { whaleStateSchema } from "./whale-state";

export const runtimeStrategyStateSchema = z.union([
  triggerStateSchema,
  copyStateSchema,
  instructionStateSchema,
  whaleStateSchema,
]);
export type RuntimeStrategyState = z.infer<typeof runtimeStrategyStateSchema>;

export function hasOpenTriggerPosition(raw: string): boolean {
  const state = runtimeStrategyStateSchema.parse(JSON.parse(raw));
  return (state.format === 1 || state.format === 3) && state.phase === "holding";
}
