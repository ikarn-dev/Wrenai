import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { instructionStateSchema } from "@/server/engine/instruction-state";
import { parseUsd, policySchema } from "@/shared/agents";
import { currentAgentStrategy } from "./asset-review";
import { privateBalanceToken } from "./balance-session";
import { ExecutionError } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { reserveDefiExecution } from "./defi-reservations";
import { preparedOrderSchema } from "./intents-order";
import { prepareIntentsOrder } from "./intents-quote";
import { dryQuoteRequest, verifiedProviderQuote } from "./oneclick-quote";
import { confirmExecutionPermission } from "./permissions";
import { databaseTime, executionEvent, executionHash, type LedgerAction } from "./records";

const paymentRecordSchema = z.strictObject({
  format: z.literal(1),
  amountUnits: z.string().regex(/^[1-9]\d{0,77}$/),
  recipient: z.string().min(2).max(64),
  order: preparedOrderSchema,
});
export type PaymentRecord = z.infer<typeof paymentRecordSchema>;
async function paymentPermission(
  db: AppDatabase,
  userId: string,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
  recipient: string,
  assetId: string,
): Promise<string> {
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (!key?.activatedAt || !key.activatedAtBlock) {
    throw new ExecutionError("not_ready", "A verified shared agent authorization is required for payments.");
  }
  return confirmExecutionPermission(db, userId, {
    agentId: current.agent.id,
    agentRevision: current.agent.revision,
    strategyVersion: current.agent.version,
    scope: "confidential",
    venueId: "confidential-intents",
    signingPublicKey: key.publicKey,
    operations: ["transfer"],
    assetIds: [assetId],
    instruments: [],
    recipients: [recipient],
    expiresAt: null,
  });
}
export async function paymentRecord(db: AppDatabase, action: LedgerAction): Promise<PaymentRecord> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "payment_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The payment has no unique immutable preparation record.");
  }
  return paymentRecordSchema.parse(JSON.parse(rows[0].detailJson));
}
export function verifiedPaymentQuote(
  action: LedgerAction,
  saved: PaymentRecord,
  accountId: string,
  now: number,
): ReturnType<typeof verifiedProviderQuote> {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    cash = plan.cash[0];
  if (
    plan.operation !== "transfer" ||
    plan.scope !== "confidential" ||
    !cash ||
    plan.cash.length !== 1 ||
    saved.recipient !== plan.recipient ||
    saved.order.payloadHash !== plan.payloadHash ||
    saved.order.depositAddress !== plan.quoteId
  ) {
    throw new ExecutionError(
      "conflict",
      "The payment destination or payload differs from its reviewed plan.",
    );
  }
  const request = {
    ...dryQuoteRequest(
      accountId,
      cash.assetId,
      cash.assetId,
      saved.amountUnits,
      Math.max(0, plan.slippageBps - 1),
      "confidential",
      saved.order.quotedAt,
    ),
    dry: false,
    recipient: saved.recipient,
    swapType: QuoteRequest.swapType.EXACT_OUTPUT,
    deadline: saved.order.requestDeadline,
  };
  const quote = verifiedProviderQuote(
    saved.order.providerQuote,
    request,
    "confidential",
    now,
    plan.slippageBps,
  );
  if (
    quote.quoteHash !== plan.quoteHash ||
    quote.inputUnits !== cash.maxDebitUnits ||
    quote.minOutputUnits !== saved.amountUnits ||
    quote.appFeeBps > plan.providerFeeBps ||
    BigInt(quote.inputMicroUsd ?? "0") > action.notionalMicroUsd
  ) {
    throw new ExecutionError(
      "conflict",
      "The payment quote changes the reserved asset, debit, fee or recipient amount.",
    );
  }
  if (
    BigInt(quote.inputUnits) < BigInt(saved.amountUnits) ||
    (BigInt(quote.inputUnits) - BigInt(saved.amountUnits)) * 10_000n >
      BigInt(saved.amountUnits) * BigInt(saved.order.maximumProviderFeeBps + plan.slippageBps)
  ) {
    throw new ExecutionError(
      "limit",
      "The same-token payment's total quoted cost exceeds its reviewed fee and slippage allowance.",
    );
  }
  return quote;
}

export async function preparePaymentExecution(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
  requestId: string,
): Promise<LedgerAction> {
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  if (existing) {
    if (existing.agentId !== agentId || existing.kind !== "defi") {
      throw new ExecutionError("conflict", "This payment request belongs to another action.");
    }
    await paymentRecord(db, existing);
    return existing;
  }
  const current = await currentAgentStrategy(db, userId, agentId, revision),
    instruction = current.strategy;
  if (instruction.kind !== "private_payments" || current.agent.status !== "running") {
    throw new ExecutionError("not_ready", "A current running payment instruction is required.");
  }
  const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.agentId, agentId)).limit(1);
  const state = runtime?.strategyStateJson
    ? instructionStateSchema.parse(JSON.parse(runtime.strategyStateJson))
    : null;
  const now = Date.now();
  if (
    state?.kind !== "private_payments" ||
    state.phase !== "waiting" ||
    state.pendingActionId !== null ||
    state.pendingSlot !== requestId ||
    now < Date.parse(instruction.executeAfter) ||
    now >= Date.parse(instruction.expiresAt)
  ) {
    throw new ExecutionError("not_ready", "This payment has no eligible persisted instruction slot.");
  }
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const session = await privateBalanceToken(db, userId);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect the private balance before preparing a payment.");
  }
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const order = await prepareIntentsOrder(
    {
      accountId: owner.accountId,
      inputAssetId: instruction.assetId,
      outputAssetId: instruction.assetId,
      inputUnits: state.quantityUnits,
      paymentRecipient: instruction.recipient,
      slippageBps: policy.maxSlippageBps,
      maximumProviderFeeBps: policy.maxProviderFeeBps,
    },
    undefined,
    session,
  );
  const envelope = z
    .object({
      quoteRequest: z.object({ deadline: z.iso.datetime() }),
      quote: z.object({ deadline: z.iso.datetime() }),
    })
    .parse(order.providerQuote);
  return userTransaction(db, userId, async (tx) => {
    const [row] = await tx.select().from(agentRuntimes).where(eq(agentRuntimes.agentId, agentId)).limit(1);
    if (row?.strategyStateJson !== runtime?.strategyStateJson || row?.state !== "active") {
      throw new ExecutionError("conflict", "The payment instruction changed during preparation.");
    }
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.agentId, agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (pending) {
      throw new ExecutionError("conflict", "Reconcile the previous action before another payment.");
    }
    const permission = await paymentPermission(
      tx,
      userId,
      current,
      instruction.recipient,
      instruction.assetId,
    );
    const plan = defiPlanSchema.parse({
      format: 2,
      requestId,
      agentId,
      agentRevision: revision,
      strategyVersion: current.agent.version,
      riskPolicyRevision: 0,
      budgetMode: "per_agent",
      scope: "confidential",
      operation: "transfer",
      venueId: "confidential-intents",
      permissionHash: permission,
      cash: [{ assetId: instruction.assetId, maxDebitUnits: order.quote.inputUnits, minCreditUnits: "0" }],
      positions: [],
      notionalMicroUsd: parseUsd(policy.maxTradeUsd).toString(),
      slippageBps: policy.maxSlippageBps,
      providerFeeBps: order.quote.appFeeBps,
      quoteId: order.depositAddress,
      quoteHash: order.quote.quoteHash,
      payloadHash: order.payloadHash,
      recipient: instruction.recipient,
      expiresAt: order.quote.expiresAt,
    });
    const action = await reserveDefiExecution(tx, userId, plan);
    const saved = paymentRecordSchema.parse({
      format: 1,
      recipient: instruction.recipient,
      amountUnits: state.quantityUnits,
      order: {
        format: 1,
        signalHash: executionHash({
          requestId,
          amountUnits: state.quantityUnits,
          recipient: instruction.recipient,
        }),
        quotedAt: order.quote.capturedAt,
        maximumProviderFeeBps: policy.maxProviderFeeBps,
        requestDeadline: envelope.quoteRequest.deadline,
        providerDeadline: envelope.quote.deadline,
        providerQuote: order.providerQuote,
        generated: order.generated,
        payloadHash: order.payloadHash,
        depositAddress: order.depositAddress,
      },
    });
    verifiedPaymentQuote(action, saved, owner.accountId, Date.now());
    await executionEvent(tx, action, "payment_prepared", await databaseTime(tx), saved);
    return action;
  });
}
