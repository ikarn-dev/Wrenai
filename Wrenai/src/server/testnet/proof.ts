import "server-only";
import { z } from "zod";
import { tokenUnitsSchema } from "@/shared/token-units";
import { TestnetError } from "./config";
import type { TestnetCall } from "./rpc";

const outcome = z.object({
  executor_id: z.string(),
  logs: z.array(z.string()),
  status: z.unknown(),
  tokens_burnt: tokenUnitsSchema,
});
export const receiptSchema = z.object({
  final_execution_status: z.literal("FINAL"),
  status: z.unknown(),
  transaction: z.object({
    hash: z.string(),
    signer_id: z.string(),
    receiver_id: z.string(),
    actions: z.array(z.unknown()).length(1),
  }),
  transaction_outcome: z.object({ outcome }),
  receipts_outcome: z.array(z.object({ id: z.string(), outcome })).min(1),
});
export type TestnetReceipt = z.infer<typeof receiptSchema>;
function succeeded(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    !("Failure" in status) &&
    ("SuccessValue" in status || "SuccessReceiptId" in status)
  );
}
export function receiptSucceeded(receipt: TestnetReceipt): boolean {
  return (
    succeeded(receipt.status) &&
    succeeded(receipt.transaction_outcome.outcome.status) &&
    receipt.receipts_outcome.every((r) => succeeded(r.outcome.status))
  );
}
export function proveCall(raw: unknown, hash: string, signer: string, call: TestnetCall): TestnetReceipt {
  const r = receiptSchema.parse(raw);
  if (
    r.transaction.hash !== hash ||
    r.transaction.signer_id !== signer ||
    r.transaction.receiver_id !== call.receiverId ||
    !receiptSucceeded(r)
  ) {
    throw new TestnetError(
      "conflict",
      "The submitted transaction needs receipt review. No repeat payment was made.",
    );
  }
  const action = r.transaction.actions[0];
  if (call.method === null) {
    const a = z.object({ Transfer: z.object({ deposit: tokenUnitsSchema }) }).parse(action);
    if (a.Transfer.deposit !== call.deposit) {
      throw new TestnetError("conflict", "The transfer amount differs from the review.");
    }
  } else {
    const a = z
      .object({
        FunctionCall: z.object({
          method_name: z.string(),
          args: z.string(),
          deposit: tokenUnitsSchema,
          gas: tokenUnitsSchema,
        }),
      })
      .parse(action);
    if (
      a.FunctionCall.method_name !== call.method ||
      a.FunctionCall.deposit !== call.deposit ||
      a.FunctionCall.gas !== call.gas ||
      !sameArguments(JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString("utf8")), call.args)
    ) {
      throw new TestnetError("conflict", "The transaction does not match this reviewed call.");
    }
  }
  return r;
}
export function creditedToken(raw: unknown, contract: string, recipient: string): bigint {
  const r = receiptSchema.parse(raw);
  if (!receiptSucceeded(r)) {
    throw new TestnetError("conflict", "The payout receipt is not fully successful.");
  }
  let amount = 0n;
  const event = z.object({
    standard: z.literal("nep141"),
    event: z.literal("ft_transfer"),
    data: z.array(z.object({ old_owner_id: z.string(), new_owner_id: z.string(), amount: tokenUnitsSchema })),
  });
  for (const node of r.receipts_outcome) {
    if (node.outcome.executor_id !== contract) {
      continue;
    }
    for (const log of node.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) {
        continue;
      }
      let data: unknown;
      try {
        data = JSON.parse(log.slice(11).trim());
      } catch {
        throw new TestnetError("conflict", "The token receipt contains invalid event data.");
      }
      const parsed = event.safeParse(data);
      if (!parsed.success) {
        continue;
      }
      for (const transfer of parsed.data.data) {
        if (transfer.new_owner_id === recipient && transfer.old_owner_id !== recipient) {
          amount += BigInt(transfer.amount);
        }
        if (transfer.old_owner_id === recipient && transfer.new_owner_id !== recipient) {
          amount -= BigInt(transfer.amount);
        }
      }
    }
  }
  return amount;
}

function sameArguments(actual: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }
  const entries = Object.entries(actual);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([key, value]) => JSON.stringify(value) === JSON.stringify(expected[key]))
  );
}

/** Net public verifier credit, including withdrawals in the same receipt graph. */
export function creditedIntents(raw: unknown, verifier: string, assetId: string, recipient: string): bigint {
  const receipt = receiptSchema.parse(raw);
  if (!receiptSucceeded(receipt)) {
    throw new TestnetError("conflict", "The public Intents receipt is not fully successful.");
  }
  const item = z.object({ token_ids: z.array(z.string()), amounts: z.array(tokenUnitsSchema) });
  const event = z.discriminatedUnion("event", [
    z.object({
      standard: z.literal("nep245"),
      version: z.literal("1.0.0"),
      event: z.literal("mt_transfer"),
      data: z.array(item.extend({ old_owner_id: z.string(), new_owner_id: z.string() })),
    }),
    z.object({
      standard: z.literal("nep245"),
      version: z.literal("1.0.0"),
      event: z.literal("mt_burn"),
      data: z.array(item.extend({ owner_id: z.string() })),
    }),
    z.object({
      standard: z.literal("nep245"),
      version: z.literal("1.0.0"),
      event: z.literal("mt_mint"),
      data: z.array(item.extend({ owner_id: z.string() })),
    }),
  ]);
  let credit = 0n;
  for (const node of receipt.receipts_outcome) {
    if (node.outcome.executor_id !== verifier) {
      continue;
    }
    for (const log of node.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) {
        continue;
      }
      const parsed = event.safeParse(JSON.parse(log.slice(11).trim()));
      if (!parsed.success) {
        continue;
      }
      for (const change of parsed.data.data) {
        if (change.token_ids.length !== change.amounts.length) {
          throw new TestnetError("conflict", "Invalid public Intents balance event.");
        }
        const sign =
          "old_owner_id" in change
            ? Number(change.new_owner_id === recipient) - Number(change.old_owner_id === recipient)
            : change.owner_id === recipient
              ? parsed.data.event === "mt_burn"
                ? -1
                : 1
              : 0;
        for (const [i, token] of change.token_ids.entries()) {
          if (token === assetId) {
            credit += BigInt(sign) * BigInt(change.amounts[i] ?? "0");
          }
        }
      }
    }
  }
  return credit;
}
