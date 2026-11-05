import { base64 } from "@scure/base";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { type WalletSwapQuote, walletSwapTransaction } from "@/shared/wallet-swap";

const callSchema = z.object({
  FunctionCall: z.object({
    method_name: z.string().max(64),
    args: z.string().max(8192),
    deposit: z.string().regex(/^\d+$/),
    gas: z.union([z.number().int().safe().nonnegative(), z.string().regex(/^\d+$/)]),
  }),
});
const transferSchema = z.object({ Transfer: z.object({ deposit: z.string().regex(/^\d+$/) }) });
const statusSchema = z.union([
  z.object({ SuccessValue: z.string().max(1024) }),
  z.object({ SuccessReceiptId: z.string().max(100) }),
  z.object({ Failure: z.unknown() }),
]);

/** A finalized deposit must match the original signer, receiver, amount and action shape. */
export function verifyWalletSwapTransaction(
  raw: unknown,
  quote: WalletSwapQuote,
  transactionHash: string,
  allowFailure = false,
): boolean {
  const expected = walletSwapTransaction(quote);
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(transactionHash),
        signer_id: z.literal(expected.signerId),
        receiver_id: z.literal(expected.receiverId),
        actions: z.array(z.union([callSchema, transferSchema])).length(expected.actions.length),
      }),
      status: statusSchema,
    })
    .safeParse(raw);
  if (!value.success) {
    throw new ExecutionError(
      "conflict",
      "The wallet transaction isn't the reviewed swap, or it didn't succeed. Check it in your wallet.",
    );
  }
  const succeeded = "SuccessValue" in value.data.status;
  if (!succeeded && !allowFailure) {
    throw new ExecutionError(
      "conflict",
      "The wallet transaction isn't the reviewed swap, or it didn't succeed. Check it in your wallet.",
    );
  }
  for (const [index, action] of value.data.transaction.actions.entries()) {
    const wanted = expected.actions[index];
    if (!wanted || !matchesAction(action, wanted)) {
      throw new ExecutionError(
        "conflict",
        "The wallet transaction doesn't match the reviewed amount or address.",
      );
    }
  }
  if ("SuccessReceiptId" in value.data.status) {
    throw new ExecutionError("not_ready", "The final swap amount could not be verified yet.");
  }
  return succeeded;
}

function matchesAction(
  action: z.infer<typeof callSchema> | z.infer<typeof transferSchema>,
  wanted: ReturnType<typeof walletSwapTransaction>["actions"][number],
): boolean {
  if (wanted.type === "Transfer") {
    return "Transfer" in action && action.Transfer.deposit === wanted.params.deposit;
  }
  if (!("FunctionCall" in action)) {
    return false;
  }
  const call = action.FunctionCall;
  const args: unknown = JSON.parse(new TextDecoder().decode(base64.decode(call.args)));
  return (
    call.method_name === wanted.params.methodName &&
    call.deposit === wanted.params.deposit &&
    BigInt(call.gas) <= BigInt(wanted.params.gas) &&
    JSON.stringify(sorted(args)) === JSON.stringify(sorted(wanted.params.args))
  );
}

function sorted(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
