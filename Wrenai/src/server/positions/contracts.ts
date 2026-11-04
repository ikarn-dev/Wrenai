import { z } from "zod";
import { hashSchema, scopeSchema } from "@/server/execution/contracts";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";

export const capitalLimitSchema = z.strictObject({ requestId: z.uuid(), amountMicroUsd: tokenUnitsSchema });
export const agentCapitalLimitSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  amountMicroUsd: tokenUnitsSchema,
});
export const inventoryAssignmentSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  scope: scopeSchema,
  assetId: z.string().trim().min(1).max(256),
  quantityUnits: positiveTokenUnitsSchema,
  capitalMicroUsd: tokenUnitsSchema,
  costBasisMicroUsd: tokenUnitsSchema.nullable(),
  sourceReference: z.string().trim().min(1).max(256),
  evidenceHash: hashSchema,
});
export const inventoryReleaseSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  scope: scopeSchema,
  assetId: z.string().trim().min(1).max(256),
  quantityUnits: positiveTokenUnitsSchema,
});

export interface LotDisposal {
  readonly lotId: string;
  readonly quantityUnits: bigint;
  readonly basisMicroUsd: bigint | null;
  readonly principalMicroUsd: bigint;
}
export interface ConsumedLots {
  readonly entries: readonly LotDisposal[];
  readonly basisMicroUsd: bigint | null;
  readonly principalMicroUsd: bigint;
}
