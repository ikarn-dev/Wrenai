import { z } from "zod";
import { copyStateSchema } from "./copy";
import { triggerStateSchema } from "./trigger";

export const runtimeStrategyStateSchema = z.union([triggerStateSchema, copyStateSchema]);
export type RuntimeStrategyState = z.infer<typeof runtimeStrategyStateSchema>;

export function hasOpenTriggerPosition(raw: string): boolean {
  const state = runtimeStrategyStateSchema.parse(JSON.parse(raw));
  return state.format === 1 && state.phase === "holding";
}
