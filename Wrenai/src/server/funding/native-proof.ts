import { base64 } from "@scure/base";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { type NativeFundingSnapshot, nativeDepositTransaction } from "@/shared/native-funding";

export function verifyNativeFunding(
  raw: unknown,
  snapshot: NativeFundingSnapshot,
  hash: string,
  role: "gas" | "token",
): string {
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(hash),
        signer_id: z.literal(snapshot.accountId),
        receiver_id: z.string(),
        actions: z.array(z.unknown()).min(1).max(3),
      }),
      transaction_outcome: z.object({ block_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/) }),
      status: z.object({ SuccessValue: z.string().max(1000) }),
    })
    .parse(raw);
  if (role === "gas") {
    const actions = z
      .array(z.object({ Transfer: z.object({ deposit: z.literal(snapshot.gasUnits) }) }))
      .length(1)
      .parse(value.transaction.actions);
    if (value.transaction.receiver_id !== snapshot.nativeAccountId || actions.length !== 1) {
      throw new ExecutionError("conflict", "The gas transfer does not match the reviewed trading account.");
    }
  } else {
    const expected = nativeDepositTransaction(snapshot);
    const calls = z
      .array(
        z.object({
          FunctionCall: z.object({
            method_name: z.string(),
            args: z.string().max(16000),
            gas: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
            deposit: z.string().regex(/^\d+$/),
          }),
        }),
      )
      .parse(value.transaction.actions);
    if (value.transaction.receiver_id !== expected.receiverId || calls.length !== expected.actions.length) {
      throw new ExecutionError("conflict", "The token funding transaction changed its target or actions.");
    }
    calls.forEach((call, index) => {
      const wanted = expected.actions[index]?.params,
        actual = call.FunctionCall;
      const args = z
        .record(z.string(), z.union([z.string(), z.boolean()]))
        .parse(JSON.parse(new TextDecoder().decode(base64.decode(actual.args))));
      const keys = Object.keys(args).sort(),
        expectedKeys = Object.keys(wanted?.args ?? {}).sort();
      if (
        !wanted ||
        wanted.methodName !== actual.method_name ||
        wanted.deposit !== actual.deposit ||
        BigInt(wanted.gas) !== BigInt(actual.gas) ||
        JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
        keys.some((key) => args[key] !== wanted.args[key])
      ) {
        throw new ExecutionError(
          "conflict",
          "The token, amount, recipient or funding memo differs from the review.",
        );
      }
    });
  }
  return value.transaction_outcome.block_hash;
}
