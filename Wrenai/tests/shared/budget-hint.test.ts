import { describe, expect, it } from "vitest";
import { divideDecimal, multiplyDecimal, parseBudgetHint } from "@/shared/budget-hint";

describe("budget from the instructions", () => {
  it("reads a one-time spend", () => {
    expect(
      parseBudgetHint("Spend 0.5 USDC once to buy ETH. Receive in my public Intents balance.", false),
    ).toMatchObject({ symbol: "USDC", amount: "0.5", perOrder: "0.5", location: null });
  });
  it("multiplies the amount by an interval over a duration, written in words too", () => {
    expect(parseBudgetHint("Spend 0.5 USDC to buy ETH every 60 seconds for one hour.", true)).toMatchObject({
      symbol: "USDC",
      amount: "30",
      basis: "60 orders × 0.5 USDC",
    });
    expect(parseBudgetHint("Spend 2 USDT on wBTC every day for 2 weeks", true)?.amount).toBe("28");
  });
  it("uses an explicit count, and a stated total over amount × count", () => {
    expect(parseBudgetHint("Spend 0.25 USDC to buy ETH 12 times", true)?.amount).toBe("3");
    expect(parseBudgetHint("Spend 1 USDC on ETH every minute, up to 5 USDC", true)).toMatchObject({
      amount: "5",
      basis: "the stated total",
    });
  });
  it("leaves the amount open when a repeating strategy has no count", () => {
    expect(parseBudgetHint("Spend 0.5 USDC to buy ETH every 60 seconds", true)).toMatchObject({
      symbol: "USDC",
      amount: null,
    });
  });
  it("reads sells, buys with a token, payments, contracts and the spend location", () => {
    expect(parseBudgetHint("Sell 0.0003 ETH for USDC when proceeds rise 5%", false)?.symbol).toBe("ETH");
    expect(parseBudgetHint("Buy NEAR with 10 usdt.tether-token.near", false)?.symbol).toBe(
      "usdt.tether-token.near",
    );
    expect(
      parseBudgetHint("Send 0.5 USDC once from my public Intents balance to bob.testnet", false),
    ).toMatchObject({ symbol: "USDC", amount: "0.5", location: "intents" });
  });
  it("reads spends without the word spend", () => {
    expect(parseBudgetHint("DCA 0.5 USDC into ETH every minute for 10 minutes", true)?.amount).toBe("5");
    expect(parseBudgetHint("Buy 1 USDT of wBTC once", false)?.symbol).toBe("USDT");
    expect(parseBudgetHint("0.25 USDC every hour, 8 times, into ETH", true)?.amount).toBe("2");
    expect(parseBudgetHint("Buy 0.0002 ETH every minute", true)).toBeNull();
  });
  it("treats an amount split across orders as the total", () => {
    expect(parseBudgetHint("buy near using 2 usdc in 2 trades", false)).toMatchObject({
      symbol: "usdc",
      amount: "2",
      perOrder: "1",
      count: 2,
    });
    expect(parseBudgetHint("Spend 1 USDC split into 3 orders", true)?.perOrder).toBe("0.333333");
    expect(parseBudgetHint("Spend 0.5 USDC per order in 4 orders", true)?.amount).toBe("2");
    expect(divideDecimal("0.000001", 2, 6)).toBeNull();
  });
  it("gives no hint for USD amounts, zero or unrelated text", () => {
    expect(parseBudgetHint("Spend $10 of NEAR every day", true)).toBeNull();
    expect(parseBudgetHint("Spend 0 USDC on ETH", false)).toBeNull();
    expect(parseBudgetHint("Buy the dip on ETH", false)).toBeNull();
  });
  it("normalizes amounts and multiplies exactly", () => {
    expect(parseBudgetHint("Spend 007.50 USDC once", false)?.amount).toBe("7.5");
    expect(multiplyDecimal("0.05", 3)).toBe("0.15");
    expect(multiplyDecimal("0.000001", 1000000)).toBe("1");
  });
});
