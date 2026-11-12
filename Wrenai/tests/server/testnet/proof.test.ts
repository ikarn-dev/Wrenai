import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { creditedIntents, creditedToken, proveCall } from "@/server/testnet/proof";
import type { TestnetCall } from "@/server/testnet/rpc";

const call: TestnetCall = {
  receiverId: "recipient.testnet",
  method: null,
  args: {},
  deposit: "100",
  gas: "0",
};
function receipt() {
  const outcome = {
    executor_id: "recipient.testnet",
    logs: [],
    status: { SuccessValue: "" },
    tokens_burnt: "1000",
  };
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: {
      hash: "hash",
      signer_id: "guest-pool.testnet",
      receiver_id: "recipient.testnet",
      actions: [{ Transfer: { deposit: "100" } }],
    },
    transaction_outcome: { outcome },
    receipts_outcome: [{ id: "receipt", outcome }],
  };
}
describe("final testnet receipt proofs", () => {
  it("accepts exact native delivery", () => {
    expect(proveCall(receipt(), "hash", "guest-pool.testnet", call).transaction.hash).toBe("hash");
  });
  it("rejects wrong owner, hash, receiver and amount", () => {
    expect(() => proveCall(receipt(), "other", "guest-pool.testnet", call)).toThrow();
    expect(() => proveCall(receipt(), "hash", "stranger.testnet", call)).toThrow();
    expect(() =>
      proveCall(receipt(), "hash", "guest-pool.testnet", { ...call, receiverId: "other.testnet" }),
    ).toThrow();
    expect(() => proveCall(receipt(), "hash", "guest-pool.testnet", { ...call, deposit: "99" })).toThrow();
  });
  it("rejects optimistic, missing and failed receipt graphs", () => {
    expect(() =>
      proveCall(
        { ...receipt(), final_execution_status: "EXECUTED_OPTIMISTIC" },
        "hash",
        "guest-pool.testnet",
        call,
      ),
    ).toThrow();
    expect(() =>
      proveCall({ ...receipt(), receipts_outcome: [] }, "hash", "guest-pool.testnet", call),
    ).toThrow();
    const failed = {
      ...receipt(),
      receipts_outcome: [
        {
          id: "failed",
          outcome: {
            executor_id: "token.testnet",
            logs: [],
            status: { SuccessValue: "", Failure: "panic" },
            tokens_burnt: "1",
          },
        },
      ],
    };
    expect(() => proveCall(failed, "hash", "guest-pool.testnet", call)).toThrow();
  });
  it("counts only the exact contract's net recipient token credit", () => {
    const r = receipt();
    const logs = [
      `EVENT_JSON:${JSON.stringify({
        standard: "nep141",
        event: "ft_transfer",
        data: [
          { old_owner_id: "maker.testnet", new_owner_id: "guest-pool.testnet", amount: "120" },
          { old_owner_id: "guest-pool.testnet", new_owner_id: "maker.testnet", amount: "20" },
        ],
      })}`,
    ];
    const raw = {
      ...r,
      receipts_outcome: [
        {
          id: "token",
          outcome: { executor_id: "token.testnet", logs, status: { SuccessValue: "" }, tokens_burnt: "0" },
        },
      ],
    };
    expect(creditedToken(raw, "token.testnet", "guest-pool.testnet")).toBe(100n);
    expect(creditedToken(raw, "wrong.testnet", "guest-pool.testnet")).toBe(0n);
  });
  it("proves net public Intents credit by exact verifier, asset and owner, including same-receipt withdrawals", () => {
    const verifier = "verifier.tidepool-sandbox.testnet",
      asset = "nep141:usdc.tidepool-sandbox.testnet";
    const logs = [
      {
        standard: "nep245",
        version: "1.0.0",
        event: "mt_transfer",
        data: [
          {
            old_owner_id: "maker.testnet",
            new_owner_id: "guest-pool.testnet",
            token_ids: [asset],
            amounts: ["120"],
          },
        ],
      },
      {
        standard: "nep245",
        version: "1.0.0",
        event: "mt_burn",
        data: [{ owner_id: "guest-pool.testnet", token_ids: [asset], amounts: ["20"] }],
      },
    ].map((e) => `EVENT_JSON:${JSON.stringify(e)}`);
    const raw = {
      ...receipt(),
      receipts_outcome: [
        {
          id: "payout",
          outcome: { executor_id: verifier, logs, status: { SuccessValue: "" }, tokens_burnt: "0" },
        },
      ],
    };
    expect(creditedIntents(raw, verifier, asset, "guest-pool.testnet")).toBe(100n);
    expect(creditedIntents(raw, "wrong.testnet", asset, "guest-pool.testnet")).toBe(0n);
    expect(creditedIntents(raw, verifier, "nep141:usdt.tidepool-sandbox.testnet", "guest-pool.testnet")).toBe(
      0n,
    );
    expect(creditedIntents(raw, verifier, asset, "stranger.testnet")).toBe(0n);
  });
});
