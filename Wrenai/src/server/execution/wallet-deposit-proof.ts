import { base64 } from "@scure/base";
import { z } from "zod";
import { type WalletFundingSnapshot, walletFundingTransaction } from "@/shared/wallet-funding";
import { ExecutionError } from "./contracts";

const statusSchema = z.object({ SuccessValue: z.string().max(1024) });
const callSchema = z.object({
  FunctionCall: z.object({
    method_name: z.string(),
    args: z.string().max(8192),
    deposit: z.string().regex(/^\d+$/),
    gas: z.union([z.number().int().safe().nonnegative(), z.string().regex(/^\d+$/)]),
  }),
});

export function verifyWalletDeposit(
  raw: unknown,
  snapshot: WalletFundingSnapshot,
  transactionHash: string,
): void {
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(transactionHash),
        signer_id: z.literal(snapshot.accountId),
        receiver_id: z.literal(snapshot.assetId.slice(7)),
        actions: z.array(callSchema).min(1).max(2),
      }),
      status: statusSchema,
    })
    .parse(raw);
  const expected = walletFundingTransaction(snapshot);
  if (value.transaction.actions.length !== expected.actions.length) {
    throw new ExecutionError("conflict", "The wallet transaction changed the reviewed deposit actions.");
  }
  for (const [index, action] of value.transaction.actions.entries()) {
    const wanted = expected.actions[index]?.params;
    const call = action.FunctionCall;
    const args: unknown = JSON.parse(new TextDecoder().decode(base64.decode(call.args)));
    const expectedKeys = Object.keys(wanted?.args ?? {}).sort();
    const parsed = z.record(z.string(), z.string()).parse(args);
    if (
      !wanted ||
      call.method_name !== wanted.methodName ||
      call.deposit !== wanted.deposit ||
      BigInt(call.gas) > BigInt(wanted.gas) ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys) ||
      expectedKeys.some((key) => parsed[key] !== wanted.args[key])
    ) {
      throw new ExecutionError(
        "conflict",
        "The wallet transaction does not match the exact token, owner and amount.",
      );
    }
  }
  const used: unknown = JSON.parse(new TextDecoder().decode(base64.decode(value.status.SuccessValue)));
  if (used !== snapshot.units) {
    throw new ExecutionError(
      "not_ready",
      "The token deposit was not fully accepted. Check its final receipt before trying another transfer.",
    );
  }
}
