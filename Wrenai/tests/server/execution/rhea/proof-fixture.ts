import { executionHash } from "@/server/execution/records";
import {
  RHEA_DCL,
  type RheaPrepared,
  rheaPreparedSchema,
  rheaSwapCall,
} from "@/server/execution/rhea/contracts";

export const nativeHash = "3".repeat(44),
  nativeBlock = "4".repeat(44);
export function nativePreparedFixture(): RheaPrepared {
  const now = Date.now();
  const prepared = rheaPreparedSchema.parse({
    format: 1,
    accountId: "a".repeat(64),
    rootId: crypto.randomUUID(),
    registrationDeposit: null,
    quoteHash: "a".repeat(64),
    payloadHash: "b".repeat(64),
    quote: {
      poolId: "raw.nearlytrade.near|wrap.near|2000",
      input: {
        symbol: "nep141:wrap.near",
        assetId: "nep141:wrap.near",
        tokenSymbol: "wNEAR",
        blockchain: "near",
        contractAddress: "wrap.near",
        decimals: 24,
      },
      output: {
        symbol: "nep141:raw.nearlytrade.near",
        assetId: "nep141:raw.nearlytrade.near",
        tokenSymbol: "RAW",
        blockchain: "near",
        contractAddress: "raw.nearlytrade.near",
        decimals: 18,
      },
      inputUnits: "100",
      outputUnits: "200",
      minimumOutputUnits: "190",
      inputMicroUsd: "1000000",
      blockHash: nativeBlock,
      observedAt: now,
      expiresAt: now + 60000,
      slippageBps: 50,
    },
  });
  return {
    ...prepared,
    quoteHash: executionHash(prepared.quote),
    payloadHash: executionHash({
      swap: rheaSwapCall(prepared),
      registrationDeposit: null,
      accountId: prepared.accountId,
    }),
  };
}
function event(oldOwner: string, newOwner: string, units: string): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: oldOwner, new_owner_id: newOwner, amount: units }] })}`;
}
export function nativeOutcomeFixture(p: RheaPrepared, used = 100n, output = 200n) {
  const call = rheaSwapCall(p),
    value = Buffer.from(JSON.stringify(used.toString())).toString("base64");
  const success = { SuccessValue: "" };
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash: nativeHash,
      signer_id: p.accountId,
      receiver_id: call.receiverId,
      actions: [
        {
          FunctionCall: {
            method_name: call.methodName,
            args: Buffer.from(JSON.stringify(call.args)).toString("base64"),
            gas: call.gas,
            deposit: call.deposit,
          },
        },
      ],
    },
    transaction_outcome: {
      id: "tx",
      block_hash: nativeBlock,
      outcome: {
        executor_id: p.accountId,
        receipt_ids: ["input"],
        logs: [],
        tokens_burnt: "1",
        status: { SuccessReceiptId: "input" },
      },
    },
    receipts_outcome: [
      {
        id: "input",
        outcome: {
          executor_id: call.receiverId,
          receipt_ids: ["output", "resolve"],
          logs: [event(p.accountId, RHEA_DCL, "100")],
          tokens_burnt: "2",
          status: { SuccessReceiptId: "resolve" },
        },
      },
      {
        id: "output",
        outcome: {
          executor_id: p.quote.output.assetId.slice(7),
          receipt_ids: [],
          logs: output > 0n ? [event(RHEA_DCL, p.accountId, output.toString())] : [],
          tokens_burnt: "3",
          status: success,
        },
      },
      {
        id: "resolve",
        outcome: {
          executor_id: call.receiverId,
          receipt_ids: [],
          logs: used < 100n ? [event(RHEA_DCL, p.accountId, (100n - used).toString())] : [],
          tokens_burnt: "4",
          status: { SuccessValue: value },
        },
      },
    ],
    status: { SuccessValue: value },
  };
}
