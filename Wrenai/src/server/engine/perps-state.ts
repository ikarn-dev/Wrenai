import { z } from "zod";
import { tokenUnitsSchema } from "@/shared/token-units";

export const perpsStateSchema = z.strictObject({
  format: z.literal(5),
  kind: z.literal("perps"),
  phase: z.enum(["funding", "entry", "holding", "completed"]),
  pendingActionId: z.uuid().nullable(),
  pendingSlot: z.uuid().nullable(),
  lastActionId: z.uuid().nullable(),
  entryActionId: z.uuid().nullable(),
  quantityUnits: tokenUnitsSchema,
  watermark: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .nullable(),
  stopPrice: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .nullable(),
});
export type PerpsState = z.infer<typeof perpsStateSchema>;
export const initialPerpsState: PerpsState = {
  format: 5,
  kind: "perps",
  phase: "funding",
  pendingActionId: null,
  pendingSlot: null,
  lastActionId: null,
  entryActionId: null,
  quantityUnits: "0",
  watermark: null,
  stopPrice: null,
};
