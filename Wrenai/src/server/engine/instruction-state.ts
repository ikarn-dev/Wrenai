import { z } from "zod";
import { type ActiveAgentTool, activeAgentToolSchema } from "@/shared/agent-scope";
import { tokenUnitsSchema } from "@/shared/token-units";

const rationalPart = z.string().regex(/^(?:0|[1-9]\d{0,155})$/);

export const instructionStateSchema = z.strictObject({
  format: z.literal(3),
  kind: activeAgentToolSchema,
  phase: z.enum(["waiting", "holding", "completed"]),
  runs: z.number().int().nonnegative().max(100_000),
  lastSlot: z.string().max(200).nullable(),
  pendingSlot: z.string().max(200).nullable(),
  pendingActionId: z.uuid().nullable(),
  lastActionId: z.uuid().nullable(),
  quantityUnits: tokenUnitsSchema,
  basisMicroUsd: tokenUnitsSchema.nullable(),
  peakPrice: z.strictObject({ n: rationalPart, d: rationalPart.refine((s) => s !== "0") }).nullable(),
  confirmationSince: z.number().int().nonnegative().nullable(),
  entryLimitPrice: z.strictObject({ n: rationalPart, d: rationalPart.refine((s) => s !== "0") }).nullable(),
  lastSampleAt: z.number().int().nonnegative().nullable(),
  lastEntryAt: z.number().int().nonnegative().nullable(),
  resetRequired: z.boolean(),
  exitTriggered: z.boolean(),
  completedTargets: z.array(z.number().int().min(0).max(9)).max(10),
  pendingTarget: z.number().int().min(0).max(9).nullable(),
  targetSoldUnits: z.array(tokenUnitsSchema).max(10),
  samples: z
    .array(
      z.strictObject({
        at: z.number().int().nonnegative(),
        n: rationalPart,
        d: rationalPart.refine((s) => s !== "0"),
      }),
    )
    .max(1441),
  coverageFrom: z.number().int().nonnegative().nullable(),
});
export type InstructionState = z.infer<typeof instructionStateSchema>;
export function initialInstructionState(kind: ActiveAgentTool): InstructionState {
  return {
    format: 3,
    kind,
    phase: "waiting",
    runs: 0,
    lastSlot: null,
    pendingSlot: null,
    pendingActionId: null,
    lastActionId: null,
    quantityUnits: "0",
    basisMicroUsd: null,
    peakPrice: null,
    entryLimitPrice: null,
    confirmationSince: null,
    lastSampleAt: null,
    lastEntryAt: null,
    resetRequired: false,
    exitTriggered: false,
    completedTargets: [],
    pendingTarget: null,
    targetSoldUnits: [],
    samples: [],
    coverageFrom: null,
  };
}
