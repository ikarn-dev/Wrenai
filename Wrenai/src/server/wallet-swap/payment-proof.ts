import { base64 } from "@scure/base";
import { z } from "zod";
import { type WalletPaymentQuote, walletPaymentTransaction } from "@/shared/chat-payment";
import { ExecutionError } from "../execution/contracts";

export function proveWalletPayment(
  raw: unknown,
  quote: WalletPaymentQuote,
  hash: string,
): {
  readonly succeeded: boolean;
  readonly blockHash: string;
} {
  const expected = walletPaymentTransaction(quote);
  const view = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(hash),
        signer_id: z.literal(expected.signerId),
        receiver_id: z.literal(expected.receiverId),
        actions: z.array(z.unknown()).min(1).max(2),
      }),
      transaction_outcome: z.object({ block_hash: z.string() }),
      status: z.union([z.object({ SuccessValue: z.string() }), z.object({ Failure: z.unknown() })]),
    })
    .parse(raw);
  const call = z.object({
    FunctionCall: z.object({
      method_name: z.string(),
      args: z.string().max(4000),
      gas: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
      deposit: z.string(),
    }),
  });
  const matches = expected.actions.every((action, index) => {
    const actual = view.transaction.actions[index];
    if (action.type === "Transfer") {
      return z.object({ Transfer: z.object({ deposit: z.literal(action.params.deposit) }) }).safeParse(actual)
        .success;
    }
    const { FunctionCall: fn } = call.parse(actual);
    const args = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .parse(JSON.parse(new TextDecoder().decode(base64.decode(fn.args))));
    return (
      fn.method_name === action.params.methodName &&
      BigInt(fn.gas) === BigInt(action.params.gas) &&
      fn.deposit === action.params.deposit &&
      Object.keys(args).length === Object.keys(action.params.args).length &&
      Object.entries(action.params.args).every(([name, value]) => args[name] === value)
    );
  });
  if (!matches || expected.actions.length !== view.transaction.actions.length) {
    throw new ExecutionError("conflict", "This transaction differs from the reviewed payment.");
  }
  return { succeeded: "SuccessValue" in view.status, blockHash: view.transaction_outcome.block_hash };
}
