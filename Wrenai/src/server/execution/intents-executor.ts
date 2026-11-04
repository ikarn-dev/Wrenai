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
import { ExecutionError, executionPlanSchema } from "@/server/execution/contracts";
import { readPreparedOrder, verifiedStoredQuote } from "@/server/execution/intents-order";
import { MAX_PROVIDER_INTENT_VALIDITY_MS, validateGeneratedIntent } from "@/server/execution/intents-payload";
import { oneClickJson } from "@/server/execution/oneclick-quote";
import { commitSignedExecution, recordSubmissionStatus } from "@/server/execution/ownership";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionEvent, ownedExecution, requireLease } from "@/server/execution/records";
import { readKeyRegistration } from "@/server/intents/verifier";
import { hashNep413Payload } from "@/server/near/nep413";
import { isRemovedExecutablePack, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { currentAgentStrategy } from "./asset-review";
import { copySubmissionCheck } from "./copy-reference";
import { instructionSubmissionCheck } from "./instruction-reference";
import { triggerSubmissionCheck } from "./trigger-reference";

export interface IntentsExecutionResult {
  readonly actionId: string;
  readonly status: "submitting" | "submitted" | "unknown" | "settled";
}

async function acceptSubmission(
  db: AppDatabase,
  userId: string,
  actionId: string,
  leaseToken: string,
  raw: unknown,
): Promise<void> {
  const receipt = z
    .object({
      intentHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
      correlationId: z.string().max(256),
    })
    .parse(raw);
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedExecution(tx, userId, actionId);
    const now = await databaseTime(tx);
    requireLease(action, leaseToken, now);
    if (action.status !== "submitting" && action.status !== "unknown") {
      throw new ExecutionError("conflict", "This submission is already acknowledged or terminal.");
    }
    await executionEvent(tx, action, "intents_submitted", now, receipt);
    await tx
      .update(executionActions)
      .set({ status: "submitted", updatedAt: now })
      .where(eq(executionActions.id, action.id));
  });
}

/** Server-owned execution only. Neither signatures nor trading secrets are returned to the browser or model. */
export async function executeIntentsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  leaseToken: string,
): Promise<IntentsExecutionResult> {
  const action = await ownedExecution(db, userId, actionId);
  if (action.status === "cancelled") {
    throw new ExecutionError("conflict", "This action was cancelled.");
  }
  if (action.status !== "reserved") {
    return { actionId, status: action.status };
  }
  const currentScope =
    action.origin === "manual"
      ? null
      : await currentAgentStrategy(db, userId, action.agentId, action.agentRevision);
  if (
    currentScope &&
    (isRemovedExecutablePack(currentScope.agent.pack) || isRemovedExecutablePack(currentScope.strategy.kind))
  ) {
    throw new ExecutionError("not_ready", REMOVED_AGENT_MESSAGE);
  }
  requireLease(action, leaseToken, await databaseTime(db));
  if (action.scope !== "confidential") {
    throw new ExecutionError("not_ready", "This Signer path only supports reviewed confidential swaps.");
  }
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [delegation] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (
    !owner ||
    !delegation ||
    delegation.activatedAt === null ||
    delegation.activatedAtBlock === null ||
    delegation.publicKey !== action.signingPublicKey
  ) {
    throw new ExecutionError("not_ready", "A registered shared agent key is required before trading.");
  }
  const publicKey = delegation.publicKey;
  const key = openAgentKey(delegation.sealedSecret, publicKey);
  const registration = await readKeyRegistration(owner.accountId, publicKey);
  if (!registration.registered || registration.blockHeight < delegation.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "The trading key is revoked or its current registration cannot be verified.",
    );
  }
  const prepared = await readPreparedOrder(db, action);
  const quote = verifiedStoredQuote(action, prepared, owner.accountId, Date.now());
  const validated = validateGeneratedIntent(prepared.generated, {
    signerId: owner.accountId,
    scope: "confidential",
    depositAddress: prepared.depositAddress,
    inputAssetId: action.inputAssetId,
    inputUnits: action.inputUnits.toString(),
    providerDeadline: prepared.providerDeadline,
    maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
    now: Date.now(),
  });
  const plan = executionPlanSchema.parse(JSON.parse(action.planJson));
  if (validated.payloadHash !== prepared.payloadHash || prepared.depositAddress !== plan.quoteId) {
    throw new ExecutionError(
      "conflict",
      "The prepared signing bytes differ from the reserved provider quote.",
    );
  }
  await synchronizePrivateInventory(db, userId);
  const current = currentScope;
  const checkInstruction = current
    ? await instructionSubmissionCheck(db, current, prepared.signal, quote, action.id)
    : null;
  const checkMarket =
    current?.strategy.kind === "triggers"
      ? await triggerSubmissionCheck(db, action, prepared, quote, current)
      : current?.strategy.kind === "copy_trading"
        ? await copySubmissionCheck(db, action, prepared, quote, current)
        : null;
  const payload = validated.intent.intent.payload;
  const signature = await commitSignedExecution(
    db,
    userId,
    actionId,
    leaseToken,
    { payloadHash: validated.payloadHash, providerRequestId: randomUUID() },
    () => {
      checkMarket?.();
      return sign(
        null,
        hashNep413Payload({
          message: payload.message,
          recipient: payload.recipient,
          nonce: Buffer.from(payload.nonce, "base64"),
        }),
        key,
      );
    },
    checkInstruction ?? undefined,
  );
  try {
    const response = await oneClickJson("/v0/submit-intent", {
      type: "swap_transfer",
      signedData: {
        ...validated.intent.intent,
        public_key: publicKey,
        signature: `ed25519:${base58.encode(signature)}`,
      },
    });
    await acceptSubmission(db, userId, actionId, leaseToken, response);
    return { actionId, status: "submitted" };
  } catch {
    // A rejected/late acknowledgement never proves the provider did not accept the signed transfer.
    await recordSubmissionStatus(db, userId, actionId, leaseToken, "unknown");
    return { actionId, status: "unknown" };
  } finally {
    signature.fill(0);
  }
}
