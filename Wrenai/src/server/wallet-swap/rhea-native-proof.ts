import { base64 } from "@scure/base";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { tokenUnitsSchema } from "@/shared/token-units";
import {
  WALLET_SWAP_RHEA_DCL,
  WALLET_SWAP_RHEA_WRAP,
  WALLET_SWAP_USDC,
  type WalletSwapQuote,
} from "@/shared/wallet-swap";

const successValue = z.object({ SuccessValue: z.string().max(10000) });
const status = z.union([
  successValue,
  z.object({ SuccessReceiptId: z.string().max(100) }),
  z.object({ Failure: z.unknown() }),
]);
const outcomeSchema = z.object({
  id: z.string().max(100),
  outcome: z.object({
    executor_id: z.string().max(64),
    receipt_ids: z.array(z.string().max(100)).max(100),
    logs: z.array(z.string().max(16000)).max(500),
    status,
  }),
});
const receiptSchema = z.object({
  receipt_id: z.string().max(100),
  predecessor_id: z.string().max(64),
  receiver_id: z.string().max(64),
  receipt: z.object({ Action: z.object({ actions: z.array(z.unknown()).max(100) }).optional() }),
});
const responseSchema = z.object({
  final_execution_status: z.literal("FINAL"),
  status,
  transaction_outcome: outcomeSchema,
  receipts_outcome: z.array(outcomeSchema).max(500),
  receipts: z.array(receiptSchema).max(500),
});
const ftTransferEvent = z.object({
  standard: z.literal("nep141"),
  version: z.literal("1.0.0"),
  event: z.literal("ft_transfer"),
  data: z
    .array(z.object({ old_owner_id: z.string(), new_owner_id: z.string(), amount: tokenUnitsSchema }))
    .min(1)
    .max(200),
});
const swapEvent = z.object({
  standard: z.literal("dcl.ref"),
  version: z.literal("1.0.0"),
  event: z.literal("swap"),
  data: z
    .array(
      z.object({
        amount_in: tokenUnitsSchema,
        amount_out: tokenUnitsSchema,
        pool_id: z.string().max(200),
        swapper: z.string().max(64),
        token_in: z.string().max(64),
        token_out: z.string().max(64),
      }),
    )
    .min(1)
    .max(20),
});
const functionCall = z.object({
  FunctionCall: z.object({ method_name: z.string().max(64), args: z.string().max(8192) }),
});
const transferAction = z.object({ Transfer: z.object({ deposit: tokenUnitsSchema }) });

type Outcome = z.infer<typeof outcomeSchema>;
type Receipt = z.infer<typeof receiptSchema>;
type Response = z.infer<typeof responseSchema>;

function pending(message: string): never {
  throw new ExecutionError("not_ready", message);
}

function parsedResponse(raw: unknown): Response {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    return pending("The final native NEAR receipt graph is not available yet.");
  }
  return parsed.data;
}

function eventValue(log: string): unknown | null {
  if (!log.startsWith("EVENT_JSON:")) {
    return null;
  }
  try {
    return JSON.parse(log.slice("EVENT_JSON:".length));
  } catch {
    return pending("A final native NEAR event could not be verified.");
  }
}

function events<T>(logs: readonly string[], schema: z.ZodType<T>): readonly T[] {
  return logs.flatMap((log) => {
    const value = eventValue(log);
    if (value === null) {
      return [];
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function decodedArgs(call: z.infer<typeof functionCall>): Record<string, unknown> | null {
  try {
    const args: unknown = JSON.parse(new TextDecoder().decode(base64.decode(call.FunctionCall.args)));
    return z.record(z.string(), z.unknown()).safeParse(args).data ?? null;
  } catch {
    return null;
  }
}

function method(receipt: Receipt, name: string): Record<string, unknown> | null {
  const calls = (receipt.receipt?.Action?.actions ?? [])
    .map((action) => functionCall.safeParse(action))
    .filter((item) => item.success)
    .filter((call) => call.data.FunctionCall.method_name === name);
  return calls.length === 1 && calls[0] ? decodedArgs(calls[0].data) : null;
}

function exactTransfer(receipt: Receipt, units: string): boolean {
  const actions = receipt.receipt?.Action?.actions ?? [];
  const action = transferAction.safeParse(actions[0]);
  return actions.length === 1 && action.success && action.data.Transfer.deposit === units;
}

function completeGraph(response: Response): {
  readonly outcomes: ReadonlyMap<string, Outcome>;
  readonly receipts: readonly Receipt[];
} {
  const all = [response.transaction_outcome, ...response.receipts_outcome];
  const outcomes = new Map(all.map((item) => [item.id, item]));
  if (outcomes.size !== all.length) {
    throw new ExecutionError("conflict", "The native NEAR response repeats a receipt outcome.");
  }
  const reached = new Set<string>();
  const pendingIds = [response.transaction_outcome.id];
  while (pendingIds.length > 0) {
    const id = pendingIds.pop();
    if (!id || reached.has(id)) {
      continue;
    }
    const item = outcomes.get(id);
    if (!item) {
      return pending("The final native NEAR receipt graph is incomplete.");
    }
    reached.add(id);
    pendingIds.push(...item.outcome.receipt_ids);
  }
  if (reached.size !== all.length) {
    throw new ExecutionError("conflict", "The native NEAR response contains unrelated receipt outcomes.");
  }
  const receiptIds = new Set(response.receipts.map((receipt) => receipt.receipt_id));
  if (receiptIds.size !== response.receipts.length) {
    throw new ExecutionError("conflict", "The native NEAR response repeats a receipt.");
  }
  if (response.receipts.some((receipt) => !reached.has(receipt.receipt_id))) {
    throw new ExecutionError("conflict", "The native NEAR response contains unrelated receipts.");
  }
  if (response.receipts_outcome.some((item) => !receiptIds.has(item.id))) {
    return pending("The final native NEAR receipt details are incomplete.");
  }
  return { outcomes, receipts: response.receipts };
}

function successful(outcome: Outcome | undefined, receiver: string): boolean {
  return (
    outcome !== undefined &&
    outcome.outcome.executor_id === receiver &&
    !("Failure" in outcome.outcome.status)
  );
}

function returnedUnits(response: Response): bigint {
  const result = successValue.safeParse(response.status);
  if (!result.success) {
    return pending("The final swap amount could not be verified yet.");
  }
  try {
    return BigInt(
      tokenUnitsSchema.parse(JSON.parse(new TextDecoder().decode(base64.decode(result.data.SuccessValue)))),
    );
  } catch {
    return pending("The final swap amount could not be verified yet.");
  }
}

function transferTotals(
  outcomes: ReadonlyMap<string, Outcome>,
  quote: WalletSwapQuote,
): { readonly sent: bigint; readonly refunded: bigint } {
  let sent = 0n;
  let refunded = 0n;
  for (const item of outcomes.values()) {
    if (
      item.outcome.executor_id !== WALLET_SWAP_USDC.slice("nep141:".length) ||
      "Failure" in item.outcome.status
    ) {
      continue;
    }
    for (const event of events(item.outcome.logs, ftTransferEvent)) {
      for (const transfer of event.data) {
        if (transfer.old_owner_id === quote.accountId && transfer.new_owner_id === WALLET_SWAP_RHEA_DCL) {
          sent += BigInt(transfer.amount);
        } else if (
          transfer.old_owner_id === WALLET_SWAP_RHEA_DCL &&
          transfer.new_owner_id === quote.accountId
        ) {
          refunded += BigInt(transfer.amount);
        } else if (transfer.old_owner_id === quote.accountId || transfer.new_owner_id === quote.accountId) {
          throw new ExecutionError("conflict", "The USDC receipt includes an unexpected owner transfer.");
        }
      }
    }
  }
  return { sent, refunded };
}

function matchingSwaps(outcomes: ReadonlyMap<string, Outcome>, quote: WalletSwapQuote) {
  return [...outcomes.values()]
    .filter(
      (item) => item.outcome.executor_id === WALLET_SWAP_RHEA_DCL && !("Failure" in item.outcome.status),
    )
    .flatMap(({ id, outcome }) =>
      events(outcome.logs, swapEvent).flatMap((event) => event.data.map((swap) => ({ ...swap, id }))),
    )
    .filter(
      (item) =>
        item.swapper === quote.accountId &&
        item.pool_id === quote.rheaPoolId &&
        item.token_in === WALLET_SWAP_USDC.slice("nep141:".length) &&
        item.token_out === WALLET_SWAP_RHEA_WRAP,
    );
}

function provesPayout(
  receipts: readonly Receipt[],
  outcomes: ReadonlyMap<string, Outcome>,
  swapReceiptId: string,
  accountId: string,
  units: string,
): boolean {
  const withdrawals = receipts.filter((receipt) => {
    const args = z.object({ amount: tokenUnitsSchema }).safeParse(method(receipt, "near_withdraw"));
    return (
      receipt.predecessor_id === WALLET_SWAP_RHEA_DCL &&
      receipt.receiver_id === WALLET_SWAP_RHEA_WRAP &&
      args.success &&
      args.data.amount === units
    );
  });
  const unwraps = receipts.filter(
    (receipt) =>
      receipt.predecessor_id === WALLET_SWAP_RHEA_WRAP &&
      receipt.receiver_id === WALLET_SWAP_RHEA_DCL &&
      // wrap.near returns the one yoctoNEAR attached to near_withdraw along with the unwrapped amount.
      exactTransfer(receipt, (BigInt(units) + 1n).toString()),
  );
  const callbacks = receipts.filter((receipt) => {
    const args = z
      .object({ amount: tokenUnitsSchema, user_id: z.literal(accountId) })
      .safeParse(method(receipt, "callback_post_withdraw_near"));
    return (
      receipt.predecessor_id === WALLET_SWAP_RHEA_DCL &&
      receipt.receiver_id === WALLET_SWAP_RHEA_DCL &&
      args.success &&
      args.data.amount === units
    );
  });
  const payouts = receipts.filter(
    (receipt) =>
      receipt.predecessor_id === WALLET_SWAP_RHEA_DCL &&
      receipt.receiver_id === accountId &&
      exactTransfer(receipt, units),
  );
  const [withdraw] = withdrawals;
  const [unwrap] = unwraps;
  const [callback] = callbacks;
  const [payout] = payouts;
  const child = (parent: string, receipt: Receipt) =>
    outcomes.get(parent)?.outcome.receipt_ids.includes(receipt.receipt_id) === true;
  return (
    withdrawals.length === 1 &&
    unwraps.length === 1 &&
    callbacks.length === 1 &&
    payouts.length === 1 &&
    !!withdraw &&
    !!unwrap &&
    !!callback &&
    !!payout &&
    child(swapReceiptId, withdraw) &&
    child(swapReceiptId, callback) &&
    child(withdraw.receipt_id, unwrap) &&
    child(callback.receipt_id, payout) &&
    [withdraw, unwrap, callback, payout].every((receipt) =>
      successful(outcomes.get(receipt.receipt_id), receipt.receiver_id),
    )
  );
}

/** Proves the exact USDC spend, DCL fill, wNEAR unwrap and native NEAR payout or full refund. */
export function verifyRheaNativePayout(
  raw: unknown,
  quote: WalletSwapQuote,
): {
  readonly state: "settled" | "refunded" | "failed";
  readonly spentUnits: string;
  readonly receivedUnits: string;
} {
  if (quote.depositKind !== "rhea_native") {
    throw new ExecutionError("conflict", "This transaction is not a native NEAR swap.");
  }
  const response = parsedResponse(raw);
  const graph = completeGraph(response);
  const sent = BigInt(quote.inputUnits);
  const transfers = transferTotals(graph.outcomes, quote);
  const swaps = matchingSwaps(graph.outcomes, quote);
  const hasPayoutEffects = graph.receipts.some(
    (receipt) =>
      receipt.predecessor_id === WALLET_SWAP_RHEA_DCL &&
      ((receipt.receiver_id === WALLET_SWAP_RHEA_WRAP && method(receipt, "near_withdraw") !== null) ||
        (receipt.receiver_id === quote.accountId &&
          (receipt.receipt.Action?.actions ?? []).some(
            (action) => transferAction.safeParse(action).success,
          ))),
  );
  if ("Failure" in response.status) {
    if (transfers.sent === 0n && transfers.refunded === 0n && swaps.length === 0 && !hasPayoutEffects) {
      return { state: "failed", spentUnits: "0", receivedUnits: "0" };
    }
    if (transfers.sent === sent && transfers.refunded === sent && swaps.length === 0 && !hasPayoutEffects) {
      return { state: "refunded", spentUnits: "0", receivedUnits: "0" };
    }
    return pending("The failed transaction's transfers are not fully verified yet.");
  }
  const used = returnedUnits(response);
  if (used > sent || transfers.refunded > transfers.sent) {
    throw new ExecutionError("conflict", "The final swap used more USDC than you approved.");
  }
  if (transfers.sent !== sent || transfers.sent - transfers.refunded !== used) {
    return pending("The final USDC amount is not fully verified yet.");
  }
  if (used === 0n) {
    if (transfers.refunded !== sent || swaps.length !== 0 || hasPayoutEffects) {
      return pending("The final refund is not fully verified yet.");
    }
    return { state: "refunded", spentUnits: "0", receivedUnits: "0" };
  }
  const swap = swaps.length === 1 ? swaps[0] : undefined;
  if (!swap || swap.amount_in !== used.toString()) {
    return pending("The native NEAR swap event is not fully verified yet.");
  }
  const output = BigInt(swap.amount_out);
  const minimum = (BigInt(quote.minimumOutputUnits) * used + sent - 1n) / sent;
  if (output < minimum) {
    throw new ExecutionError("conflict", "The final native NEAR output is below the reviewed minimum.");
  }
  if (!provesPayout(graph.receipts, graph.outcomes, swap.id, quote.accountId, swap.amount_out)) {
    return pending("The native NEAR payout is not fully verified yet.");
  }
  return { state: "settled", spentUnits: used.toString(), receivedUnits: output.toString() };
}
