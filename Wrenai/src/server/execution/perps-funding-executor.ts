import "server-only";
import { and, eq } from "drizzle-orm";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { perpsStateSchema } from "@/server/engine/perps-state";
import { submitConfidentialTransfer } from "./confidential-transfer";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { verifiedAccountFunding } from "./funding-policy";
import { synchronizePerpsInventory } from "./hyperliquid/account-state";
import { perpsFundingRecord, verifiedFundingQuote } from "./perps-funding-order";
import { ownedLedgerAction } from "./records";

export async function executePerpsFunding(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (action.kind !== "defi" || action.status !== "reserved" || !plan.funding) {
    throw new ExecutionError("not_ready", "Only an unsent owned-account deposit may be signed.");
  }
  await verifiedAccountFunding(db, userId, plan);
  const saved = await perpsFundingRecord(db, action);
  await synchronizePerpsInventory(db, userId, action.agentId);
  await submitConfidentialTransfer(
    db,
    action,
    token,
    saved.order,
    (owner) => verifiedFundingQuote(action, saved, owner, Date.now()),
    async (tx) => {
      await verifiedAccountFunding(tx, userId, plan);
      const [runtime] = await tx
        .select()
        .from(agentRuntimes)
        .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, action.agentId)))
        .limit(1);
      const state = runtime?.strategyStateJson
        ? perpsStateSchema.parse(JSON.parse(runtime.strategyStateJson))
        : null;
      if (
        runtime?.state !== "active" ||
        runtime.strategyVersion !== action.strategyVersion ||
        runtime.agentRevision !== action.agentRevision ||
        state?.phase !== "funding" ||
        state.pendingSlot !== action.requestId ||
        (state.pendingActionId !== null && state.pendingActionId !== action.id)
      ) {
        throw new ExecutionError("not_ready", "The owned-account funding slot changed before signing.");
      }
    },
    "perps_funding_submitted",
  );
}
