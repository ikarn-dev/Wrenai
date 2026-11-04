import "server-only";
import { randomUUID, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { openAgentKey } from "@/server/delegation/agent-key";
import { synchronizePublicToken } from "@/server/funding/public-inventory";
import { readKeyRegistration } from "@/server/intents/verifier";
import { hashNep413Payload } from "@/server/near/nep413";
import type { TradeQuote } from "@/shared/trade-preview";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import type { preparedOrderSchema } from "./intents-order";
import { MAX_PROVIDER_INTENT_VALIDITY_MS, validateGeneratedIntent } from "./intents-payload";
import { oneClickJson } from "./oneclick-quote";
import { commitSignedExecution, recordSubmissionStatus } from "./ownership";
import { synchronizePrivateInventory } from "./private-inventory";
import { databaseTime, executionEvent, type LedgerAction, ownedLedgerAction, requireLease } from "./records";

/** Shared signed transfer transport. Each caller independently verifies destination and strategy authority. */
export async function submitConfidentialTransfer(
  db: AppDatabase,
  action: LedgerAction,
  leaseToken: string,
  saved: z.infer<typeof preparedOrderSchema>,
  quoteForOwner: (accountId: string) => TradeQuote,
  validateState: (tx: AppDatabase) => Promise<void>,
  eventKind: "payment_submitted" | "perps_funding_submitted" | "wallet_conversion_submitted",
  checkRecipient?: () => Promise<void>,
): Promise<void> {
  const userId = action.userId,
    actionId = action.id,
    plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (
    plan.scope !== "confidential" &&
    (plan.scope !== "intents" || !plan.walletFundingId || eventKind !== "wallet_conversion_submitted")
  ) {
    throw new ExecutionError(
      "not_ready",
      "This transport requires a verified private transfer or owned wallet funding.",
    );
  }
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (!owner || !key?.activatedAtBlock || !key.activatedAt || key.publicKey !== action.signingPublicKey) {
    throw new ExecutionError("not_ready", "The shared transfer authorization is unavailable.");
  }
  const quote = quoteForOwner(owner.accountId),
    validated = validateGeneratedIntent(saved.generated, {
      signerId: owner.accountId,
      scope: plan.scope,
      depositAddress: saved.depositAddress,
      inputAssetId: quote.inputAssetId,
      inputUnits: quote.inputUnits,
      providerDeadline: saved.providerDeadline,
      maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
      now: Date.now(),
    });
  if (validated.payloadHash !== plan.payloadHash) {
    throw new ExecutionError("conflict", "The transfer signing bytes changed.");
  }
  const checks = await Promise.allSettled([
    readKeyRegistration(owner.accountId, key.publicKey),
    synchronizePrivateInventory(db, userId),
    checkRecipient ? checkRecipient() : Promise.resolve(),
  ]);
  const [registration, inventory, recipient] = checks;
  if (registration.status === "rejected") {
    throw registration.reason;
  }
  if (inventory.status === "rejected") {
    throw inventory.reason;
  }
  if (recipient.status === "rejected") {
    throw recipient.reason;
  }
  if (!registration.value.registered || registration.value.blockHeight < key.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "The shared transfer authorization is revoked or could not be verified.",
    );
  }
  if (plan.scope === "intents") {
    await synchronizePublicToken(db, userId, owner.accountId, quote.inputAssetId);
  }
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
      const [current] = await tx
        .select()
        .from(delegatedKeys)
        .where(eq(delegatedKeys.userId, userId))
        .limit(1);
      if (
        !current?.activatedAt ||
        current.publicKey !== key.publicKey ||
        !current.sealedSecret.equals(key.sealedSecret)
      ) {
        throw new ExecutionError("not_ready", "The transfer authorization changed before signing.");
      }
      await validateState(tx);
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
      await executionEvent(tx, row, eventKind, now, response);
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
