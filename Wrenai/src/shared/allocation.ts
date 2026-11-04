import { z } from "zod";
import { positiveTokenUnitsSchema } from "./token-units";

export const allocationCommandSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  scope: z.enum(["confidential", "intents"]),
  assetId: z
    .string()
    .regex(/^nep141:[a-z0-9._-]+$/)
    .max(256),
  quantityUnits: positiveTokenUnitsSchema,
  targetAgentId: z.uuid().nullable(),
});
export interface AgentAllocation {
  readonly scope: "confidential" | "intents";
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly ownedUnits: string;
  readonly availableUnits: string;
  readonly principalMicroUsd: string;
}
export interface AgentAllocationView {
  readonly agentId: string;
  readonly revision: number;
  readonly running: boolean;
  readonly allocations: readonly AgentAllocation[];
  readonly targets: readonly { readonly id: string; readonly name: string; readonly assetId: string }[];
}
