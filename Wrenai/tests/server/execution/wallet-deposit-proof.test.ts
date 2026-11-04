import { fundingSnapshot } from "@tests/server/funding/context";
import { describe, expect, it, vi } from "vitest";
import { verifyWalletDeposit } from "@/server/execution/wallet-deposit-proof";
import { walletFundingTransaction } from "@/shared/wallet-funding";

vi.mock("server-only", () => ({}));
const hash = "1".repeat(44);
function proof(snapshot = fundingSnapshot()) {
  const tx = walletFundingTransaction(snapshot);
  return {
    snapshot,
    response: {
      final_execution_status: "FINAL",
      status: { SuccessValue: Buffer.from(JSON.stringify(snapshot.units)).toString("base64") },
      transaction: {
        hash,
        signer_id: tx.signerId,
        receiver_id: tx.receiverId,
        actions: tx.actions.map(({ params }) => ({
          FunctionCall: {
            method_name: params.methodName,
            args: Buffer.from(JSON.stringify(params.args)).toString("base64"),
            deposit: params.deposit,
            gas: params.gas,
          },
        })),
      },
    },
  };
}
describe("exact finalized wallet deposit proof", () => {
  it("accepts the exact FT owner deposit and wraps native NEAR before depositing", () => {
    const ft = proof();
    expect(() => verifyWalletDeposit(ft.response, ft.snapshot, hash)).not.toThrow();
    const near = proof({
      ...fundingSnapshot(),
      walletAssetId: "native:near",
      assetId: "nep141:wrap.near",
      symbol: "NEAR",
      decimals: 24,
    });
    expect(near.response.transaction.actions).toHaveLength(2);
    expect(() => verifyWalletDeposit(near.response, near.snapshot, hash)).not.toThrow();
  });
  it.each(["signer", "token", "amount", "memo", "recipient", "refund", "finality", "extra_action"])(
    "rejects a changed %s",
    (kind) => {
      const { snapshot, response } = proof();
      if (kind === "signer") {
        response.transaction.signer_id = "stranger.near";
      }
      if (kind === "token") {
        response.transaction.receiver_id = "fake-usdc.near";
      }
      if (kind === "finality") {
        response.final_execution_status = "EXECUTED";
      }
      if (kind === "refund") {
        response.status.SuccessValue = Buffer.from('"4999999"').toString("base64");
      }
      const call = response.transaction.actions[0]?.FunctionCall;
      if (!call) {
        throw new Error("Missing fixture call");
      }
      if (kind === "extra_action") {
        response.transaction.actions.push({ FunctionCall: { ...call } });
      }
      if (["amount", "memo", "recipient"].includes(kind)) {
        call.args = Buffer.from(
          JSON.stringify({
            receiver_id: kind === "recipient" ? "stranger.near" : "intents.near",
            amount: kind === "amount" ? "1" : snapshot.units,
            msg: snapshot.accountId,
            memo: kind === "memo" ? "unrelated transfer" : `Wrenai funding ${snapshot.fundingId}`,
          }),
        ).toString("base64");
      }
      expect(() => verifyWalletDeposit(response, snapshot, hash)).toThrow();
    },
  );
});
