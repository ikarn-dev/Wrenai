import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import type { LedgerAction } from "../records";
import { hlAccountStateSchema } from "./account-state";
import { hlActionSchema, hlAddressSchema } from "./contracts";
import { hlMarketObservationSchema } from "./market";

export const hlOrderRecordSchema = z.strictObject({
  format: z.literal(1),
  address: hlAddressSchema,
  instructionHash: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["entry", "exit"]),
  exitReason: z.enum(["user", "stop_loss", "take_profit", "trailing", "expiry"]).nullable(),
  action: hlActionSchema,
  leverage: hlActionSchema.nullable(),
  market: hlMarketObservationSchema,
  account: hlAccountStateSchema,
  availableCashUnits: tokenUnitsSchema,
  beforeCashUnits: tokenUnitsSchema,
  requestedUnits: tokenUnitsSchema,
  beforeCollateralUnits: tokenUnitsSchema,
  beforeExposureUnits: tokenUnitsSchema,
  beforeCollateralPrincipal: tokenUnitsSchema,
});
export type HlOrderRecord = z.infer<typeof hlOrderRecordSchema>;
export async function readHlOrder(db: AppDatabase, action: LedgerAction): Promise<HlOrderRecord> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "hl_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The venue order has no unique immutable preparation record.");
  }
  return hlOrderRecordSchema.parse(JSON.parse(rows[0].detailJson));
}
