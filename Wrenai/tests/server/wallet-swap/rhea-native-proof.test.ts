import { rheaHash, rheaNativeOutcome, rheaNativeQuote } from "@tests/server/wallet-swap/rhea-native-fixture";
import mainnetPayout from "@tests/server/wallet-swap/rhea-native-mainnet.fixture.json";
import { describe, expect, it, vi } from "vitest";
import { verifyWalletSwapTransaction } from "@/server/wallet-swap/proof";
import { verifyRheaNativePayout } from "@/server/wallet-swap/rhea-native-proof";

vi.mock("server-only", () => ({}));

describe("wallet USDC to native NEAR proof", () => {
  it("reconciles the captured mainnet USDC swap after the RHEA DAO upgrade", () => {
    // Finalized transaction Hb2Wsh7ZHDjppqk4Xi2cRypyKTwUUtJ1ssywohYvfJ4C, block 223172626.
    const base = rheaNativeQuote();
    const quote = {
      ...base,
      accountId: mainnetPayout.transaction.signer_id,
      request: { ...base.request, amount: "187.347759" },
      inputUnits: "187347759",
      outputUnits: "47758282110774464399825181",
      minimumOutputUnits: "47742891461036936093761536",
    };
    expect(verifyRheaNativePayout(mainnetPayout, quote)).toEqual({
      state: "settled",
      spentUnits: "187347759",
      receivedUnits: "47758282110774464399825181",
    });
  });

  it("binds the exact wallet call and proves a full native NEAR payout", () => {
    const quote = rheaNativeQuote();
    const raw = rheaNativeOutcome(quote);
    expect(verifyWalletSwapTransaction(raw, quote, rheaHash, true)).toBe(true);
    expect(verifyRheaNativePayout(raw, quote)).toEqual({
      state: "settled",
      spentUnits: "1000000",
      receivedUnits: "250000000000000000000000",
    });
  });

  it("proves a proportional partial fill and exact USDC refund", () => {
    const quote = rheaNativeQuote();
    expect(
      verifyRheaNativePayout(
        rheaNativeOutcome(quote, { used: 500_000n, output: 120_000_000_000_000_000_000_000n }),
        quote,
      ),
    ).toEqual({
      state: "settled",
      spentUnits: "500000",
      receivedUnits: "120000000000000000000000",
    });
  });

  it("proves a full USDC refund and a failure before any effects", () => {
    const quote = rheaNativeQuote();
    expect(verifyRheaNativePayout(rheaNativeOutcome(quote, { used: 0n, output: 0n }), quote)).toEqual({
      state: "refunded",
      spentUnits: "0",
      receivedUnits: "0",
    });
    expect(verifyRheaNativePayout(rheaNativeOutcome(quote, { failed: true }), quote)).toEqual({
      state: "failed",
      spentUnits: "0",
      receivedUnits: "0",
    });
  });

  it("rejects a changed signer, call, pool and output below the reviewed minimum", () => {
    const quote = rheaNativeQuote();
    const signer = rheaNativeOutcome(quote);
    signer.transaction.signer_id = "stranger.near";
    expect(() => verifyWalletSwapTransaction(signer, quote, rheaHash, true)).toThrow();

    const changedCall = rheaNativeOutcome(quote);
    const action = changedCall.transaction.actions[0];
    if (!action) {
      throw new Error("Missing fixture action.");
    }
    action.FunctionCall.deposit = "2";
    expect(() => verifyWalletSwapTransaction(changedCall, quote, rheaHash, true)).toThrow();

    const pool = rheaNativeOutcome(quote);
    const swap = pool.receipts_outcome.find((item) => item.id === "swap");
    if (!swap?.outcome.logs[0]) {
      throw new Error("Missing fixture swap.");
    }
    swap.outcome.logs[0] = swap.outcome.logs[0].replace(quote.rheaPoolId ?? "", "other|pool|100");
    expect(() => verifyRheaNativePayout(pool, quote)).toThrow();

    expect(() =>
      verifyRheaNativePayout(rheaNativeOutcome(quote, { output: 239_999_999_999_999_999_999_999n }), quote),
    ).toThrow("below the reviewed minimum");
  });

  it("rejects missing, duplicated, unrelated and failed payout receipts", () => {
    const quote = rheaNativeQuote();
    const missing = rheaNativeOutcome(quote);
    missing.receipts_outcome = missing.receipts_outcome.filter((item) => item.id !== "payout");
    expect(() => verifyRheaNativePayout(missing, quote)).toThrow("incomplete");

    const duplicate = rheaNativeOutcome(quote);
    const first = duplicate.receipts_outcome[0];
    if (!first) {
      throw new Error("Missing fixture receipt.");
    }
    duplicate.receipts_outcome.push(first);
    expect(() => verifyRheaNativePayout(duplicate, quote)).toThrow("repeats");

    const unrelated = rheaNativeOutcome(quote);
    unrelated.receipts_outcome.push({
      id: "unrelated",
      outcome: { executor_id: "other.near", receipt_ids: [], logs: [], status: { SuccessValue: "" } },
    });
    expect(() => verifyRheaNativePayout(unrelated, quote)).toThrow("unrelated");

    const failedPayout = rheaNativeOutcome(quote);
    const payout = failedPayout.receipts_outcome.find((item) => item.id === "payout");
    if (!payout) {
      throw new Error("Missing fixture payout.");
    }
    failedPayout.receipts_outcome.splice(failedPayout.receipts_outcome.indexOf(payout), 1, {
      ...payout,
      outcome: { ...payout.outcome, status: { Failure: { ActionError: "fixture" } } },
    });
    expect(() => verifyRheaNativePayout(failedPayout, quote)).toThrow("not fully verified");
  });

  it("rejects wrong payout amounts, malformed logs and malformed return values", () => {
    const quote = rheaNativeQuote();
    const payout = rheaNativeOutcome(quote);
    const payoutReceipt = payout.receipts.find((item) => item.receipt_id === "payout");
    if (!payoutReceipt?.receipt?.Action) {
      throw new Error("Missing fixture payout action.");
    }
    payoutReceipt.receipt.Action.actions[0] = { Transfer: { deposit: "1" } };
    expect(() => verifyRheaNativePayout(payout, quote)).toThrow("not fully verified");

    const malformedLog = rheaNativeOutcome(quote);
    const swap = malformedLog.receipts_outcome.find((item) => item.id === "swap");
    if (!swap) {
      throw new Error("Missing fixture swap.");
    }
    swap.outcome.logs = ["EVENT_JSON:{"];
    expect(() => verifyRheaNativePayout(malformedLog, quote)).toThrow("could not be verified");

    const malformedReturn = rheaNativeOutcome(quote);
    malformedReturn.status = { SuccessValue: "not-base64" };
    expect(() => verifyRheaNativePayout(malformedReturn, quote)).toThrow("amount could not be verified");
  });

  it("requires the native payout to come from the reviewed swap callback", () => {
    const quote = rheaNativeQuote();
    const raw = rheaNativeOutcome(quote);
    const callback = raw.receipts_outcome.find(({ id }) => id === "callback");
    const unwrap = raw.receipts_outcome.find(({ id }) => id === "unwrap");
    if (!callback || !unwrap) {
      throw new Error("Missing native payout receipt.");
    }
    callback.outcome.receipt_ids = [];
    unwrap.outcome.receipt_ids = ["payout"];
    expect(() => verifyRheaNativePayout(raw, quote)).toThrow("not fully verified");
  });
});
