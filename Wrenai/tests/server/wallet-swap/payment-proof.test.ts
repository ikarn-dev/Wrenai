import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { proveWalletPayment } from "@/server/wallet-swap/payment-proof";
import { type WalletPaymentQuote, walletPaymentTransaction } from "@/shared/chat-payment";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";

const hash = "a".repeat(43);
const native: WalletPaymentQuote = {
  kind: "payment",
  request: {
    requestId: crypto.randomUUID(),
    assetId: WALLET_SWAP_NATIVE_OUTPUT,
    amount: "1",
    recipient: "alice.near",
  },
  accountId: "owner.near",
  symbol: "NEAR",
  units: "1000000000000000000000000",
  registrationUnits: "0",
  registerRecipient: false,
};

function finalReceipt(quote: WalletPaymentQuote) {
  const call = walletPaymentTransaction(quote);
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash,
      signer_id: call.signerId,
      receiver_id: call.receiverId,
      actions: call.actions.map((action) =>
        action.type === "Transfer"
          ? { Transfer: action.params }
          : {
              FunctionCall: {
                method_name: action.params.methodName,
                args: base64.encode(new TextEncoder().encode(JSON.stringify(action.params.args))),
                gas: action.params.gas,
                deposit: action.params.deposit,
              },
            },
      ),
    },
    transaction_outcome: { block_hash: "b".repeat(43) },
    status: { SuccessValue: "" },
  };
}

describe("wallet payment proof", () => {
  it("binds the native asset, recipient and amount to a finalized transfer", () => {
    const raw = finalReceipt(native);
    expect(raw.transaction.receiver_id).toBe("alice.near");
    expect(proveWalletPayment(raw, native, hash).succeeded).toBe(true);
    expect(() => proveWalletPayment(finalReceipt({ ...native, units: "5" }), native, hash)).toThrow();
    expect(() => proveWalletPayment({ ...raw, final_execution_status: "EXECUTED" }, native, hash)).toThrow();
    expect(proveWalletPayment({ ...raw, status: { Failure: {} } }, native, hash).succeeded).toBe(false);
  });

  it("requires the exact wrapped contract and any reviewed registration deposit", () => {
    const wrapped = {
      ...native,
      request: { ...native.request, assetId: WALLET_SWAP_INPUT },
      symbol: "wNEAR",
      registrationUnits: "1250",
      registerRecipient: true,
    };
    const raw = finalReceipt(wrapped);
    expect(raw.transaction.receiver_id).toBe("wrap.near");
    expect(raw.transaction.actions).toHaveLength(2);
    expect(proveWalletPayment(raw, wrapped, hash).succeeded).toBe(true);
    expect(() => proveWalletPayment(raw, native, hash)).toThrow();
    expect(() =>
      proveWalletPayment(
        finalReceipt({ ...wrapped, registrationUnits: "0", registerRecipient: false }),
        wrapped,
        hash,
      ),
    ).toThrow();
  });

  it("keeps required zero-cost registration in the exact approval", () => {
    const quote = {
      ...native,
      request: { ...native.request, assetId: "nep141:token.near" },
      registerRecipient: true,
    };
    const raw = finalReceipt(quote);
    expect(raw.transaction.actions).toHaveLength(2);
    expect(proveWalletPayment(raw, quote, hash).succeeded).toBe(true);
  });
});
