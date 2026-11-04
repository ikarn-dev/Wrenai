import { describe, expect, it, vi } from "vitest";
import { verifyNativeFunding } from "@/server/funding/native-proof";
import {
  NATIVE_FUNDING_GAS,
  nativeDepositTransaction,
  nativeFundingSnapshotSchema,
} from "@/shared/native-funding";

vi.mock("server-only", () => ({}));
describe("wallet-to-native funding proof", () => {
  const s = nativeFundingSnapshotSchema.parse({
    id: "30000000-0000-4000-8000-000000000001",
    userId: "owner",
    accountId: "owner.near",
    subjectId: "30000000-0000-4000-8000-000000000002",
    agentId: null,
    rootId: "30000000-0000-4000-8000-000000000003",
    nativeAccountId: "a".repeat(64),
    sourceAssetId: "native:near",
    assetId: "nep141:wrap.near",
    units: "1000000000000000000000000",
    decimals: 24,
    tokenSymbol: "wNEAR",
    gasUnits: NATIVE_FUNDING_GAS,
    registrationUnits: "1250000000000000000000",
  });
  const hash = "3".repeat(44),
    block = "4".repeat(44);
  function receipt() {
    const call = nativeDepositTransaction(s);
    return {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction: {
        hash,
        signer_id: s.accountId,
        receiver_id: call.receiverId,
        actions: call.actions.map((a) => ({
          FunctionCall: {
            method_name: a.params.methodName,
            args: Buffer.from(JSON.stringify(a.params.args)).toString("base64"),
            deposit: a.params.deposit,
            gas: a.params.gas,
          },
        })),
      },
      transaction_outcome: { block_hash: block },
    };
  }
  it("wraps only exact native units, registers the correct receiver and carries a unique funding memo", () => {
    const transaction = nativeDepositTransaction(s);
    expect(transaction.actions).toHaveLength(3);
    expect(verifyNativeFunding(receipt(), s, hash, "token")).toBe(block);
  });
  it("rejects a changed recipient, hash, signer or amount", () => {
    const raw = receipt();
    expect(() => verifyNativeFunding(raw, s, "5".repeat(44), "token")).toThrow();
    expect(() =>
      verifyNativeFunding(
        { ...raw, transaction: { ...raw.transaction, signer_id: "stranger.near" } },
        s,
        hash,
        "token",
      ),
    ).toThrow();
    const call = raw.transaction.actions[2];
    if (!call) {
      throw new Error("No transfer");
    }
    call.FunctionCall.args = Buffer.from(
      JSON.stringify({ receiver_id: "stranger.near", amount: s.units, memo: `wrenai-native:${s.id}` }),
    ).toString("base64");
    expect(() => verifyNativeFunding(raw, s, hash, "token")).toThrow();
  });
  it("cannot reuse another funding request's exact-token transfer", () => {
    expect(() =>
      verifyNativeFunding(receipt(), { ...s, id: "30000000-0000-4000-8000-000000000004" }, hash, "token"),
    ).toThrow();
  });
});
