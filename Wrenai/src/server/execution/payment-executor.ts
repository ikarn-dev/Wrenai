import "server-only";
import { randomUUID, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { openAgentKey } from "@/server/delegation/agent-key";
import { instructionStateSchema } from "@/server/engine/instruction-state";
import { readKeyRegistration } from "@/server/intents/verifier";
import { hashNep413Payload } from "@/server/near/nep413";
import { currentAgentStrategy } from "./asset-review";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { MAX_PROVIDER_INTENT_VALIDITY_MS, validateGeneratedIntent } from "./intents-payload";
import { oneClickJson } from "./oneclick-quote";
import { commitSignedExecution, recordSubmissionStatus } from "./ownership";
import { paymentRecord, verifiedPaymentQuote } from "./payment-order";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, ownedLedgerAction, requireLease } from "./records";

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
    instruction.kind !== "private_payments" ||
    instruction.recipient !== saved.recipient ||
    instruction.assetId !== plan.cash[0]?.assetId
  ) {
    throw new ExecutionError("conflict", "The payment no longer matches its reviewed recipient and token.");
  }
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (!owner || !key?.activatedAtBlock || !key.activatedAt || key.publicKey !== action.signingPublicKey) {
    throw new ExecutionError("not_ready", "The shared payment authorization is unavailable.");
  }
  const registered = await readKeyRegistration(owner.accountId, key.publicKey);
  if (!registered.registered || registered.blockHeight < key.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "The shared payment authorization is revoked or could not be verified.",
    );
  }
  const quote = verifiedPaymentQuote(action, saved, owner.accountId, Date.now());
  const validated = validateGeneratedIntent(saved.order.generated, {
    signerId: owner.accountId,
    scope: "confidential",
    depositAddress: saved.order.depositAddress,
    inputAssetId: instruction.assetId,
    inputUnits: quote.inputUnits,
    providerDeadline: saved.order.providerDeadline,
    maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
    now: Date.now(),
  });
  if (validated.payloadHash !== plan.payloadHash) {
    throw new ExecutionError("conflict", "The payment signing bytes changed.");
  }
  await synchronizePrivateInventory(db, userId);
  const signingKey = openAgentKey(key.sealedSecret, key.publicKey),
    payload = validated.intent.intent.payload;
  const signature = await commitSignedExecution(
    db,
    userId,
    actionId,
    leaseToken,
    { payloadHash: validated.payloadHash, providerRequestId: randomUUID() },
    () =>
      sign(
        null,
        hashNep413Payload({
          message: payload.message,
          recipient: payload.recipient,
          nonce: Buffer.from(payload.nonce, "base64"),
        }),
        signingKey,
      ),
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
  );
  try {
    const response = z
      .object({
        intentHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
        correlationId: z.string().max(256),
      })
      .parse(
        await oneClickJson("/v0/submit-intent", {
          type: "swap_transfer",
          signedData: {
            ...validated.intent.intent,
            public_key: key.publicKey,
            signature: `ed25519:${base58.encode(signature)}`,
          },
        }),
      );
    await userTransaction(db, userId, async (tx) => {
      const row = await ownedLedgerAction(tx, userId, actionId),
        now = await databaseTime(tx);
      requireLease(row, leaseToken, now);
      await executionEvent(tx, row, "payment_submitted", now, response);
      await tx
        .update(executionActions)
        .set({ status: "submitted", updatedAt: now })
        .where(eq(executionActions.id, actionId));
    });
  } catch {
    await recordSubmissionStatus(db, userId, actionId, leaseToken, "unknown");
  } finally {
    signature.fill(0);
  }
}
