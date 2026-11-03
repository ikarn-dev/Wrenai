import "server-only";
import { and, eq } from "drizzle-orm";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { instructionStateSchema } from "@/server/engine/instruction-state";
import { currentAgentStrategy } from "./asset-review";
import { submitConfidentialTransfer } from "./confidential-transfer";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { paymentRecord, verifiedPaymentQuote } from "./payment-order";
import { assertPublicPaymentRecipient } from "./public-payment-recipient";
import { databaseTime, ownedLedgerAction } from "./records";

export async function executePaymentAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  leaseToken: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.kind !== "defi" || action.status !== "reserved") {
    throw new ExecutionError("not_ready", "Only an unsent reserved payment may be signed.");
  }
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    saved = await paymentRecord(db, action);
  const current = await currentAgentStrategy(db, userId, action.agentId, action.agentRevision),
    instruction = current.strategy;
  if (
    plan.funding ||
    instruction.kind !== "private_payments" ||
    instruction.destination !== (saved.destination ?? "confidential") ||
    instruction.recipient !== saved.recipient ||
    instruction.assetId !== plan.cash[0]?.assetId
  ) {
    throw new ExecutionError("conflict", "The payment no longer matches its reviewed recipient and token.");
  }
  await submitConfidentialTransfer(
    db,
    action,
    leaseToken,
    saved.order,
    (accountId) => verifiedPaymentQuote(action, saved, accountId, Date.now()),
    async (tx) => {
      const [runtime] = await tx
        .select()
        .from(agentRuntimes)
        .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, action.agentId)))
        .limit(1);
      const state = runtime?.strategyStateJson
        ? instructionStateSchema.parse(JSON.parse(runtime.strategyStateJson))
        : null;
      const now = await databaseTime(tx);
      if (
        state?.kind !== "private_payments" ||
        state.phase !== "waiting" ||
        (state.pendingActionId !== null && state.pendingActionId !== action.id) ||
        state.pendingSlot !== action.requestId ||
        state.quantityUnits !== saved.amountUnits ||
        runtime?.state !== "active" ||
        runtime.strategyVersion !== action.strategyVersion ||
        runtime.agentRevision !== action.agentRevision ||
        now < Date.parse(instruction.executeAfter) ||
        now >= Date.parse(instruction.expiresAt)
      ) {
        throw new ExecutionError(
          "not_ready",
          "The exact-amount payment slot changed or expired before signing.",
        );
      }
    },
    "payment_submitted",
    () => assertPublicPaymentRecipient(instruction),
  );
}
