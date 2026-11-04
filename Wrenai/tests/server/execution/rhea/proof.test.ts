import {
  nativeHash,
  nativeOutcomeFixture,
  nativePreparedFixture,
} from "@tests/server/execution/rhea/proof-fixture";
import { describe, expect, it, vi } from "vitest";
import { rheaSwapCall } from "@/server/execution/rhea/contracts";
import { verifyNativeOutcome } from "@/server/execution/rhea/proof";

vi.mock("server-only", () => ({}));
describe("final native RHEA execution proofs", () => {
  it("binds the exact pool, token, recipient, size, min output, gas and deposit", () => {
    const p = nativePreparedFixture(),
      call = rheaSwapCall(p);
    expect(JSON.parse(call.args.msg)).toEqual({
      Swap: {
        pool_ids: [p.quote.poolId],
        output_token: p.quote.output.assetId.slice(7),
        min_output_amount: "190",
      },
    });
    expect(verifyNativeOutcome(nativeOutcomeFixture(p), p, nativeHash, "swap")).toEqual({
      used: 100n,
      output: 200n,
      gas: 10n,
      succeeded: true,
    });
  });
  it("proves a full refund independently of the original quote", () => {
    const p = nativePreparedFixture();
    expect(verifyNativeOutcome(nativeOutcomeFixture(p, 0n, 0n), p, nativeHash, "swap")).toMatchObject({
      used: 0n,
      output: 0n,
      gas: 10n,
    });
  });
  it("accepts only a proportionally bounded partial fill", () => {
    const p = nativePreparedFixture();
    expect(verifyNativeOutcome(nativeOutcomeFixture(p, 50n, 95n), p, nativeHash, "swap").used).toBe(50n);
    expect(() => verifyNativeOutcome(nativeOutcomeFixture(p, 50n, 94n), p, nativeHash, "swap")).toThrow();
  });
  it("rejects insufficient output, an unrelated hash and receipts from another owner", () => {
    const p = nativePreparedFixture();
    expect(() => verifyNativeOutcome(nativeOutcomeFixture(p, 100n, 189n), p, nativeHash, "swap")).toThrow();
    expect(() => verifyNativeOutcome(nativeOutcomeFixture(p), p, "5".repeat(44), "swap")).toThrow();
    const wrong = nativeOutcomeFixture(p);
    wrong.transaction.signer_id = "b".repeat(64);
    expect(() => verifyNativeOutcome(wrong, p, nativeHash, "swap")).toThrow();
  });
  it("rejects incomplete finality, a missing receipt and duplicated receipts", () => {
    const p = nativePreparedFixture(),
      raw = nativeOutcomeFixture(p);
    expect(() =>
      verifyNativeOutcome({ ...raw, final_execution_status: "EXECUTED" }, p, nativeHash, "swap"),
    ).toThrow();
    expect(() =>
      verifyNativeOutcome(
        { ...raw, receipts_outcome: raw.receipts_outcome.slice(0, 2) },
        p,
        nativeHash,
        "swap",
      ),
    ).toThrow();
    expect(() =>
      verifyNativeOutcome(
        { ...raw, receipts_outcome: [...raw.receipts_outcome, raw.receipts_outcome[0]] },
        p,
        nativeHash,
        "swap",
      ),
    ).toThrow();
  });
  it("refuses changed signing calls and an output claimed by the input token", () => {
    const p = nativePreparedFixture(),
      raw = nativeOutcomeFixture(p),
      action = raw.transaction.actions[0];
    if (!action) {
      throw new Error("No call");
    }
    action.FunctionCall.deposit = "100";
    expect(() => verifyNativeOutcome(raw, p, nativeHash, "swap")).toThrow();
    const confused = nativeOutcomeFixture(p),
      output = confused.receipts_outcome[1];
    if (!output) {
      throw new Error("No output");
    }
    output.outcome.executor_id = p.quote.input.assetId.slice(7);
    expect(() => verifyNativeOutcome(confused, p, nativeHash, "swap")).toThrow();
  });
});
