import { base64 } from "@scure/base";
import { z } from "zod";
import { tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { RHEA_DCL, type RheaPrepared, rheaSwapCall } from "./contracts";

const success = z.object({ SuccessValue: z.string().max(10000) });
const status = z.union([
  success,
  z.object({ SuccessReceiptId: z.string() }),
  z.object({ Failure: z.unknown() }),
]);
const outcome = z.object({
  id: z.string(),
  outcome: z.object({
    executor_id: z.string(),
    receipt_ids: z.array(z.string()).max(100),
    logs: z.array(z.string().max(16000)).max(500),
    tokens_burnt: tokenUnitsSchema,
    status,
  }),
});
const transfer = z.object({
  standard: z.literal("nep141"),
  version: z.literal("1.0.0"),
  event: z.literal("ft_transfer"),
  data: z
    .array(z.object({ old_owner_id: z.string(), new_owner_id: z.string(), amount: tokenUnitsSchema }))
    .min(1)
    .max(200),
});

export function verifyNativeOutcome(
  raw: unknown,
  prepared: RheaPrepared,
  hash: string,
  role: "registration" | "swap",
): { used: bigint; output: bigint; gas: bigint; succeeded: boolean } {
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(hash),
        signer_id: z.literal(prepared.accountId),
        receiver_id: z.string(),
        actions: z
          .array(
            z.object({
              FunctionCall: z.object({
                method_name: z.string(),
                args: z.string().max(12000),
                gas: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
                deposit: tokenUnitsSchema,
              }),
            }),
          )
          .length(1),
      }),
      transaction_outcome: outcome,
      receipts_outcome: z.array(outcome).max(500),
      status,
    })
    .parse(raw);
  const call = value.transaction.actions[0]?.FunctionCall,
    swap = rheaSwapCall(prepared);
  if (!call) {
    throw new ExecutionError("conflict", "The native receipt has no bound call.");
  }
  const wanted =
    role === "swap"
      ? {
          receiverId: swap.receiverId,
          methodName: swap.methodName,
          args: swap.args,
          gas: swap.gas,
          deposit: swap.deposit,
        }
      : {
          receiverId: prepared.quote.output.assetId.slice(7),
          methodName: "storage_deposit",
          args: { account_id: prepared.accountId, registration_only: true },
          gas: "30000000000000",
          deposit: prepared.registrationDeposit,
        };
  const args: unknown = JSON.parse(new TextDecoder().decode(base64.decode(call.args)));
  if (
    value.transaction.receiver_id !== wanted.receiverId ||
    call.method_name !== wanted.methodName ||
    call.deposit !== wanted.deposit ||
    BigInt(call.gas) !== BigInt(wanted.gas) ||
    JSON.stringify(args) !== JSON.stringify(wanted.args)
  ) {
    throw new ExecutionError("conflict", "The native transaction changed its token, call or exact limits.");
  }
  const all = [value.transaction_outcome, ...value.receipts_outcome],
    byId = new Map(all.map((item) => [item.id, item]));
  const reached = new Set<string>(),
    queue = [value.transaction_outcome.id];
  while (queue.length) {
    const id = queue.pop();
    if (!id || reached.has(id)) {
      continue;
    }
    const item = byId.get(id);
    if (!item) {
      throw new ExecutionError("not_ready", "The native receipt graph is incomplete.");
    }
    reached.add(id);
    queue.push(...item.outcome.receipt_ids);
  }
  if (reached.size !== all.length || byId.size !== all.length) {
    throw new ExecutionError("conflict", "The native response contains unrelated or duplicated receipts.");
  }
  const gas = all.reduce((sum, item) => sum + BigInt(item.outcome.tokens_burnt), 0n);
  if (role === "registration") {
    return { gas, used: 0n, output: 0n, succeeded: success.safeParse(value.status).success };
  }
  let sent = 0n,
    refunded = 0n,
    output = 0n;
  for (const item of value.receipts_outcome) {
    if (!("SuccessValue" in item.outcome.status) && !("SuccessReceiptId" in item.outcome.status)) {
      continue;
    }
    for (const log of item.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) {
        continue;
      }
      const event = transfer.safeParse(JSON.parse(log.slice(11)));
      if (!event.success) {
        continue;
      }
      for (const t of event.data.data) {
        if (item.outcome.executor_id === prepared.quote.input.assetId.slice(7)) {
          if (t.old_owner_id === prepared.accountId && t.new_owner_id === RHEA_DCL) {
            sent += BigInt(t.amount);
          } else if (t.old_owner_id === RHEA_DCL && t.new_owner_id === prepared.accountId) {
            refunded += BigInt(t.amount);
          } else if (t.old_owner_id === prepared.accountId || t.new_owner_id === prepared.accountId) {
            throw new ExecutionError("conflict", "The native input receipt includes an unexpected transfer.");
          }
        }
        if (
          item.outcome.executor_id === prepared.quote.output.assetId.slice(7) &&
          t.old_owner_id === RHEA_DCL &&
          t.new_owner_id === prepared.accountId
        ) {
          output += BigInt(t.amount);
        }
      }
    }
  }
  const used = sent - refunded,
    result = success.safeParse(value.status);
  const returned = result.success
    ? tokenUnitsSchema.parse(JSON.parse(new TextDecoder().decode(base64.decode(result.data.SuccessValue))))
    : "0";
  if (
    used < 0n ||
    sent > BigInt(prepared.quote.inputUnits) ||
    (used === 0n) !== (output === 0n) ||
    returned !== used.toString() ||
    (used > 0n &&
      output * BigInt(prepared.quote.inputUnits) < BigInt(prepared.quote.minimumOutputUnits) * used)
  ) {
    throw new ExecutionError(
      "conflict",
      "The final token transfers do not prove the reviewed fill or full refund.",
    );
  }
  return { used, output, gas, succeeded: result.success };
}
