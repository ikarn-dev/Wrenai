import { type WalletSwapQuote, walletSwapQuoteSchema, walletSwapTransaction } from "@/shared/wallet-swap";

export const rheaHash = "7".repeat(44);
const inputUnits = 1_000_000n;
const outputUnits = 250_000_000_000_000_000_000_000n;

export function rheaNativeQuote(): WalletSwapQuote {
  return walletSwapQuoteSchema.parse({
    request: {
      requestId: crypto.randomUUID(),
      amount: "1",
      inputAssetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      outputAssetId: "native:near",
      slippageBps: 400,
      maximumFeeBps: 1,
    },
    accountId: "owner.near",
    depositAddress: null,
    depositKind: "rhea_native",
    pairVerified: true,
    rheaPoolId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100",
    rheaBlockHash: "6".repeat(44),
    input: {
      symbol: "USDC",
      tokenSymbol: "USDC",
      assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      blockchain: "near",
      contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: 6,
    },
    output: {
      symbol: "NEAR",
      tokenSymbol: "NEAR",
      assetId: "native:near",
      blockchain: "near",
      contractAddress: null,
      decimals: 24,
    },
    inputUnits: inputUnits.toString(),
    outputUnits: outputUnits.toString(),
    minimumOutputUnits: ((outputUnits * 96n) / 100n).toString(),
    appFeeBps: 0,
    quoteHash: "a".repeat(64),
  });
}

type FixtureStatus =
  | { readonly SuccessValue: string }
  | { readonly Failure: { readonly ActionError: string } };

function outcome(
  id: string,
  executor: string,
  receiptIds: readonly string[],
  logs: readonly string[] = [],
  status: FixtureStatus = { SuccessValue: "" },
) {
  return {
    id,
    outcome: {
      executor_id: executor,
      receipt_ids: [...receiptIds],
      logs: [...logs],
      status,
    },
  };
}

function receipt(id: string, predecessor: string, receiver: string, actions: readonly unknown[]) {
  return {
    receipt_id: id,
    predecessor_id: predecessor,
    receiver_id: receiver,
    receipt: { Action: { actions: [...actions] } },
  };
}

function call(method: string, args: Record<string, unknown>) {
  return {
    FunctionCall: {
      method_name: method,
      args: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  };
}

function transfer(deposit: bigint) {
  return { Transfer: { deposit: deposit.toString() } };
}

function ftEvent(oldOwner: string, newOwner: string, amount: bigint): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "nep141",
    version: "1.0.0",
    event: "ft_transfer",
    data: [{ old_owner_id: oldOwner, new_owner_id: newOwner, amount: amount.toString() }],
  })}`;
}

function swapEvent(quote: WalletSwapQuote, used: bigint, output: bigint): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "dcl.ref",
    version: "1.0.0",
    event: "swap",
    data: [
      {
        amount_in: used.toString(),
        amount_out: output.toString(),
        pool_id: quote.rheaPoolId,
        swapper: quote.accountId,
        token_in: quote.input.contractAddress,
        token_out: "wrap.near",
      },
    ],
  })}`;
}

/**
 * Synthetic USDC fixture with the receipt links observed in the public DCL native payout
 * 3KLa6rChtaSopkGdMSewn5irRJekrfU5GermtF9PvZrZ.
 */
export function rheaNativeOutcome(
  quote: WalletSwapQuote,
  options: {
    readonly used?: bigint;
    readonly output?: bigint;
    readonly failed?: boolean;
  } = {},
) {
  const sent = BigInt(quote.inputUnits);
  const used = options.used ?? sent;
  const output = options.output ?? BigInt(quote.outputUnits);
  const refunded = sent - used;
  const transaction = walletSwapTransaction(quote);
  const action = transaction.actions[0];
  if (action?.type !== "FunctionCall") {
    throw new Error("RHEA fixture requires one function call.");
  }
  const raw = {
    final_execution_status: "FINAL",
    transaction: {
      hash: rheaHash,
      signer_id: transaction.signerId,
      receiver_id: transaction.receiverId,
      actions: [
        {
          FunctionCall: {
            method_name: action.params.methodName,
            args: Buffer.from(JSON.stringify(action.params.args)).toString("base64"),
            gas: action.params.gas,
            deposit: action.params.deposit,
          },
        },
      ],
    },
    transaction_outcome: outcome("tx", quote.accountId, ["usdc-call"]),
    receipts_outcome: [] as ReturnType<typeof outcome>[],
    receipts: [] as ReturnType<typeof receipt>[],
    status: options.failed
      ? { Failure: { ActionError: "fixture" } }
      : { SuccessValue: Buffer.from(JSON.stringify(used.toString())).toString("base64") },
  };
  if (options.failed) {
    raw.receipts_outcome.push(
      outcome("usdc-call", quote.input.contractAddress ?? "", ["gas-refund"], [], {
        Failure: { ActionError: "fixture" },
      }),
      outcome("gas-refund", quote.accountId, []),
    );
    raw.receipts.push(
      receipt("usdc-call", quote.accountId, quote.input.contractAddress ?? "", []),
      receipt("gas-refund", "system", quote.accountId, [transfer(1n)]),
    );
    return raw;
  }
  const usdcLogs = [ftEvent(quote.accountId, "dclv2.ref-labs.near", sent)];
  const resolveLogs = refunded > 0n ? [ftEvent("dclv2.ref-labs.near", quote.accountId, refunded)] : [];
  if (used === 0n) {
    raw.receipts_outcome.push(
      outcome("usdc-call", quote.input.contractAddress ?? "", ["swap", "resolve"], usdcLogs),
      // A reverted slippage check can still leave a swap log in the failed DCL outcome.
      outcome("swap", "dclv2.ref-labs.near", [], [swapEvent(quote, sent, output)], {
        Failure: { ActionError: "slippage error" },
      }),
      outcome("resolve", quote.input.contractAddress ?? "", [], resolveLogs),
    );
    raw.receipts.push(
      receipt("usdc-call", quote.accountId, quote.input.contractAddress ?? "", []),
      receipt("swap", quote.input.contractAddress ?? "", "dclv2.ref-labs.near", []),
      receipt("resolve", quote.input.contractAddress ?? "", quote.input.contractAddress ?? "", []),
    );
    return raw;
  }
  raw.receipts_outcome.push(
    outcome("usdc-call", quote.input.contractAddress ?? "", ["swap", "resolve"], usdcLogs),
    outcome("swap", "dclv2.ref-labs.near", ["withdraw", "callback"], [swapEvent(quote, used, output)]),
    outcome("resolve", quote.input.contractAddress ?? "", [], resolveLogs),
    outcome("withdraw", "wrap.near", ["unwrap"]),
    outcome("unwrap", "dclv2.ref-labs.near", []),
    outcome("callback", "dclv2.ref-labs.near", ["payout"]),
    outcome("payout", quote.accountId, []),
  );
  raw.receipts.push(
    receipt("usdc-call", quote.accountId, quote.input.contractAddress ?? "", []),
    receipt("swap", quote.input.contractAddress ?? "", "dclv2.ref-labs.near", []),
    receipt("resolve", quote.input.contractAddress ?? "", quote.input.contractAddress ?? "", []),
    receipt("withdraw", "dclv2.ref-labs.near", "wrap.near", [
      call("near_withdraw", { amount: output.toString() }),
    ]),
    receipt("unwrap", "wrap.near", "dclv2.ref-labs.near", [transfer(output + 1n)]),
    receipt("callback", "dclv2.ref-labs.near", "dclv2.ref-labs.near", [
      call("callback_post_withdraw_near", { amount: output.toString(), user_id: quote.accountId }),
    ]),
    receipt("payout", "dclv2.ref-labs.near", quote.accountId, [transfer(output)]),
  );
  return raw;
}
