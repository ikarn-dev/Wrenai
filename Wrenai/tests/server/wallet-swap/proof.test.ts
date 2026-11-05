import { describe, expect, it } from "vitest";
import { verifyWalletSwapTransaction } from "@/server/wallet-swap/proof";
import { type WalletSwapQuote, WRAP_STORAGE_YOCTO, walletSwapTransaction } from "@/shared/wallet-swap";

const quote: WalletSwapQuote = {
  request: {
    requestId: crypto.randomUUID(),
    amount: "0.1",
    outputAssetId: "nep141:usdc.test-fixture.near",
    slippageBps: 50,
    maximumFeeBps: 20,
  },
  accountId: "owner.near",
  depositAddress: "a".repeat(64),
  input: {
    symbol: "NEAR",
    tokenSymbol: "NEAR",
    assetId: "nep141:wrap.near",
    blockchain: "near",
    contractAddress: "wrap.near",
    decimals: 24,
  },
  output: {
    symbol: "USDC",
    tokenSymbol: "USDC",
    assetId: "nep141:usdc.test-fixture.near",
    blockchain: "near",
    contractAddress: "usdc.test-fixture.near",
    decimals: 6,
  },
  inputUnits: "100000000000000000000000",
  outputUnits: "410000",
  minimumOutputUnits: "408000",
  appFeeBps: 20,
  quoteHash: "b".repeat(64),
};
const hash = "8".repeat(44);

function receipt(
  changes: { readonly receiver?: string; readonly amount?: string; readonly signer?: string } = {},
) {
  const tx = walletSwapTransaction(quote);
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash,
      signer_id: changes.signer ?? tx.signerId,
      receiver_id: tx.receiverId,
      actions: tx.actions.map((action) => {
        if (action.type === "Transfer") {
          return { Transfer: { deposit: action.params.deposit } };
        }
        const args =
          action.params.methodName === "ft_transfer"
            ? {
                receiver_id: changes.receiver ?? quote.depositAddress,
                amount: changes.amount ?? quote.inputUnits,
              }
            : action.params.args;
        return {
          FunctionCall: {
            method_name: action.params.methodName,
            args: Buffer.from(JSON.stringify(args)).toString("base64"),
            deposit: action.params.deposit,
            gas: Number(action.params.gas),
          },
        };
      }),
    },
    status: { SuccessValue: "" },
  };
}

describe("wallet swap transaction", () => {
  it("registers the deposit address, wraps the exact NEAR and sends it there, all on wrap.near", () => {
    const tx = walletSwapTransaction(quote);
    expect(tx).toMatchObject({ signerId: "owner.near", receiverId: "wrap.near" });
    expect(
      tx.actions.map((a) => a.type === "FunctionCall" && [a.params.methodName, a.params.deposit]),
    ).toEqual([
      ["storage_deposit", WRAP_STORAGE_YOCTO],
      ["near_deposit", quote.inputUnits],
      ["ft_transfer", "1"],
    ]);
  });
  it("accepts only the exact reviewed transaction", () => {
    expect(() => verifyWalletSwapTransaction(receipt(), quote, hash)).not.toThrow();
    expect(() => verifyWalletSwapTransaction(receipt({ receiver: "attacker.near" }), quote, hash)).toThrow();
    expect(() => verifyWalletSwapTransaction(receipt({ amount: "1" }), quote, hash)).toThrow();
    expect(() => verifyWalletSwapTransaction(receipt({ signer: "stranger.near" }), quote, hash)).toThrow();
    expect(() =>
      verifyWalletSwapTransaction({ ...receipt(), status: { Failure: {} } }, quote, hash),
    ).toThrow();
  });
  it("accepts only a finalized, exact native NEAR transfer for new swaps", () => {
    const native: WalletSwapQuote = { ...quote, depositKind: "native_near" };
    const transaction = walletSwapTransaction(native);
    expect(transaction).toEqual({
      signerId: "owner.near",
      receiverId: native.depositAddress,
      actions: [{ type: "Transfer", params: { deposit: native.inputUnits } }],
    });
    const raw = {
      ...receipt(),
      transaction: {
        hash,
        signer_id: transaction.signerId,
        receiver_id: transaction.receiverId,
        actions: [{ Transfer: { deposit: native.inputUnits } }],
      },
    };
    expect(() => verifyWalletSwapTransaction(raw, native, hash)).not.toThrow();
    expect(() => verifyWalletSwapTransaction(receipt(), native, hash)).toThrow();
    expect(() =>
      verifyWalletSwapTransaction(
        { ...raw, transaction: { ...raw.transaction, actions: [{ Transfer: { deposit: "1" } }] } },
        native,
        hash,
      ),
    ).toThrow();
  });
});

describe("wallet native RHEA transaction", () => {
  it("binds one exact USDC call to the reviewed pool and native NEAR minimum", async () => {
    const { rheaHash, rheaNativeOutcome, rheaNativeQuote } = await import(
      "@tests/server/wallet-swap/rhea-native-fixture"
    );
    const native = rheaNativeQuote();
    const transaction = walletSwapTransaction(native);
    expect(transaction).toEqual({
      signerId: native.accountId,
      receiverId: native.input.contractAddress,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: {
              receiver_id: "dclv2.ref-labs.near",
              amount: native.inputUnits,
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [native.rheaPoolId],
                  output_token: "wrap.near",
                  min_output_amount: native.minimumOutputUnits,
                  skip_unwrap_near: false,
                },
              }),
            },
            gas: "180000000000000",
            deposit: "1",
          },
        },
      ],
    });
    expect(verifyWalletSwapTransaction(rheaNativeOutcome(native), native, rheaHash, true)).toBe(true);
  });

  it("rejects native RHEA quotes without the reviewed pair marker", () => {
    const invalid = {
      ...quote,
      depositAddress: null,
      depositKind: "rhea_native" as const,
      request: {
        ...quote.request,
        inputAssetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        outputAssetId: "native:near",
      },
    };
    expect(() => walletSwapTransaction(invalid)).toThrow("Invalid RHEA native quote");
  });
});
