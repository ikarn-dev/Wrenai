import { describe, expect, it, vi } from "vitest";
import { type NativeReturnRecord, nativeReturnCall } from "@/server/execution/rhea/return-order";
import { verifyNativeReturn } from "@/server/execution/rhea/return-settle";

vi.mock("server-only", () => ({}));

const account = "a".repeat(64);
const hash = "3".repeat(44);
function record(assetId: string, registrationDeposit: string | null = null): NativeReturnRecord {
  return {
    format: 1,
    rootId: crypto.randomUUID(),
    accountId: account,
    publicKey: "ed25519:offline-test-key",
    recipient: "owner.near",
    assetId,
    units: "100",
    registrationDeposit,
    payloadHash: "b".repeat(64),
  };
}
function outcome(id: string, executor: string, logs: string[] = [], failed = false) {
  return {
    id,
    outcome: {
      executor_id: executor,
      receipt_ids: [],
      logs,
      tokens_burnt: "1000",
      status: failed ? { Failure: { ActionError: {} } } : { SuccessValue: "" },
    },
  };
}
function transferLog(from: string, to: string, amount: string): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "nep141",
    version: "1.0.0",
    event: "ft_transfer",
    data: [{ old_owner_id: from, new_owner_id: to, amount }],
  })}`;
}
/** A FINAL transaction carrying exactly the saved calls, like NEAR RPC returns it. */
function finalTransaction(saved: NativeReturnRecord, receipts: unknown[], failed = false) {
  const call = nativeReturnCall(saved);
  const actions =
    call.kind === "near"
      ? [{ Transfer: { deposit: call.amount } }]
      : call.calls.map((c) => ({
          FunctionCall: {
            method_name: c.methodName,
            args: Buffer.from(JSON.stringify(c.args)).toString("base64"),
            gas: Number(c.gas),
            deposit: c.deposit,
          },
        }));
  return {
    final_execution_status: "FINAL",
    transaction: { hash, signer_id: account, receiver_id: call.receiverId, actions },
    transaction_outcome: { ...outcome("tx", account), block_hash: "4".repeat(44) },
    receipts_outcome: receipts,
    status: failed ? { Failure: { ActionError: {} } } : { SuccessValue: "" },
  };
}

describe("native trading-account returns", () => {
  it("proves an ft_transfer of the exact saved amount to the owner, with storage registration", () => {
    const saved = record("nep141:token.near", "1250000000000000000000");
    expect(nativeReturnCall(saved)).toMatchObject({
      kind: "ft",
      receiverId: "token.near",
      calls: [{ methodName: "storage_deposit" }, { methodName: "ft_transfer", deposit: "1" }],
    });
    const raw = finalTransaction(saved, [
      outcome("r1", "token.near", [transferLog(account, "owner.near", "100")]),
    ]);
    expect(verifyNativeReturn(raw, saved, hash)).toMatchObject({ delivered: 100n, gas: 2000n });
  });

  it("rejects a transfer to any account other than the owner", () => {
    const saved = record("nep141:token.near");
    const raw = finalTransaction(saved, [
      outcome("r1", "token.near", [transferLog(account, "stranger.near", "100")]),
    ]);
    expect(() => verifyNativeReturn(raw, saved, hash)).toThrow("unexpected account");
  });

  it("rejects a transaction whose calls differ from the saved return", () => {
    const saved = record("nep141:token.near");
    const raw = finalTransaction({ ...saved, units: "101" }, [
      outcome("r1", "token.near", [transferLog(account, "owner.near", "101")]),
    ]);
    expect(() => verifyNativeReturn(raw, saved, hash)).toThrow("differs from its saved");
  });

  it("reports nothing delivered when the transfer failed, so the funds stay with the agent", () => {
    const saved = record("nep141:token.near");
    const raw = finalTransaction(saved, [outcome("r1", "token.near", [], true)], true);
    expect(verifyNativeReturn(raw, saved, hash).delivered).toBe(0n);
  });

  it("returns native NEAR with one plain transfer of the held amount", () => {
    const saved = record("native:near");
    expect(nativeReturnCall(saved)).toEqual({ kind: "near", receiverId: "owner.near", amount: "100" });
    expect(
      verifyNativeReturn(finalTransaction(saved, [outcome("r1", "owner.near")]), saved, hash).delivered,
    ).toBe(100n);
  });
});
