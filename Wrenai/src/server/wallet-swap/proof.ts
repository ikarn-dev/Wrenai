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

/**
 * Checks a final NEAR transaction is exactly the reviewed wallet swap: signed by the owner, sent to wrap.near,
 * the same three calls with the same arguments and deposits, and successful. Anything else isn't recorded.
 */
export function verifyWalletSwapTransaction(
  raw: unknown,
  quote: WalletSwapQuote,
  transactionHash: string,
): void {
  const expected = walletSwapTransaction(quote);
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(transactionHash),
        signer_id: z.literal(expected.signerId),
        receiver_id: z.literal(expected.receiverId),
        actions: z.array(callSchema).length(expected.actions.length),
      }),
      status: z.object({ SuccessValue: z.string().max(1024) }),
    })
    .safeParse(raw);
  if (!value.success) {
    throw new ExecutionError(
      "conflict",
      "The wallet transaction isn't the reviewed swap, or it didn't succeed. Check it in your wallet.",
    );
  }
  for (const [index, action] of value.data.transaction.actions.entries()) {
    const wanted = expected.actions[index]?.params;
    const call = action.FunctionCall;
    const args: unknown = JSON.parse(new TextDecoder().decode(base64.decode(call.args)));
    if (
      !wanted ||
      call.method_name !== wanted.methodName ||
      call.deposit !== wanted.deposit ||
      BigInt(call.gas) > BigInt(wanted.gas) ||
      JSON.stringify(sorted(args)) !== JSON.stringify(sorted(wanted.args))
    ) {
      throw new ExecutionError(
        "conflict",
        "The wallet transaction doesn't match the reviewed amount or address.",
      );
    }
  }
}

function sorted(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
