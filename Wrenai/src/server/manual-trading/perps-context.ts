import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import type { PerpsInstruction } from "@/server/execution/hyperliquid/order-plan";
import { executionHash, type LedgerAction } from "@/server/execution/records";
import type { AgentPolicy } from "@/shared/agents";
import { manualOrderPolicy } from "./policy";
import { manualEnvelope, ownedManualTrade } from "./record";
import { requireManualSubject } from "./subject";

export async function manualPerpsContext(
  db: AppDatabase,
  action: LedgerAction,
): Promise<{ instruction: PerpsInstruction; policy: AgentPolicy }> {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (action.origin !== "manual" || !plan.manualTradeId) {
    throw new ExecutionError("conflict", "This is not a confirmed manual position.");
  }
  const row = await ownedManualTrade(db, action.userId, plan.manualTradeId),
    envelope = manualEnvelope(row);
  await requireManualSubject(db, action.userId, action.agentId);
  if (
    row.status !== "confirmed" ||
    row.actionId !== action.id ||
    envelope.kind !== "perps" ||
    envelope.preview.intent.kind !== "perps" ||
    envelope.instruction.kind !== "perps" ||
    action.planHash !== executionHash(envelope.plan)
  ) {
    throw new ExecutionError("conflict", "The manual position does not match its confirmation.");
  }
  return { instruction: envelope.instruction, policy: manualOrderPolicy(envelope.preview.intent) };
}
