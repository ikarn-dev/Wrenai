import {
  accountFixture,
  fixtureAddress,
  marketFixture,
  orderFixture,
  perpsInstruction,
  perpsPolicy,
} from "@tests/server/execution/hyperliquid/fixtures";
import { describe, expect, it, vi } from "vitest";
import type { HlAccountState } from "@/server/execution/hyperliquid/account-state";
import type { HlOrder } from "@/server/execution/hyperliquid/contracts";
import { accountPerpsFills } from "@/server/execution/hyperliquid/fill-accounting";
import { corroboratePerpsLiquidations } from "@/server/execution/hyperliquid/liquidation";
import type { HlFill, IsolatedLiquidation } from "@/server/execution/hyperliquid/observations";
import { composePerpsOrder } from "@/server/execution/hyperliquid/order-plan";

vi.mock("server-only", () => ({}));

function positionState(quantity: string, cash: string): HlAccountState {
  return accountFixture(cash, {
    assetPositions:
      quantity === "0"
        ? []
        : [
            {
              type: "oneWay",
              position: {
                coin: "NEAR",
                szi: quantity,
                entryPx: "5",
                marginUsed: "2.4955",
                positionValue: "10",
                unrealizedPnl: "0",
                leverage: { type: "isolated", value: 4, rawUsd: "-7.5045" },
              },
            },
          ],
  });
}
function fill(overrides: Partial<HlFill> = {}): HlFill {
  return {
    coin: "NEAR",
    px: "5",
    sz: "2",
    startPosition: "0",
    closedPnl: "0",
    side: "B",
    hash: `0x${"a".repeat(64)}`,
    oid: 100,
    tid: 1,
    time: Date.now(),
    fee: "0.0045",
    feeToken: "USDC",
    ...overrides,
  };
}
function parentOrder(action: ReturnType<typeof orderFixture>["action"]): HlOrder {
  if (action.type !== "order" || !action.orders[0]) {
    throw new Error("Missing parent fixture.");
  }
  return action.orders[0];
}
describe("exact owned Perps fill accounting", () => {
  it("records only actual partial long and short fills, with exact collateral and fees", () => {
    const saved = orderFixture(),
      parent = parentOrder(saved.action);
    expect(
      accountPerpsFills(saved, positionState("2", "17.4"), [fill()], new Map([[100, parent]]), 50),
    ).toMatchObject({ quantity: 200n, debit: 2500000n, collateral: 2495500n, risk: 10004500n, fee: 4500n });
    const instruction = perpsInstruction({
      side: "short",
      exits: { stopLossPrice: "6", takeProfitPrice: "4", trailingStopBps: null },
    });
    const short = orderFixture({
      action: composePerpsOrder(instruction, perpsPolicy, marketFixture(), crypto.randomUUID(), 20_000_000n)
        .action,
    });
    expect(
      accountPerpsFills(
        short,
        positionState("-2", "17.4"),
        [fill({ side: "A" })],
        new Map([[100, parentOrder(short.action)]]),
        50,
      )?.quantity,
    ).toBe(200n);
  });
  it("reduces owned exposure and apportions remaining collateral without applying entry caps to gains", () => {
    const instruction = perpsInstruction({ action: "reduce", quantity: "2" });
    const saved = orderFixture({
      role: "exit",
      beforeExposureUnits: "400",
      beforeCashUnits: "14900000",
      beforeCollateralUnits: "5000000",
      beforeCollateralPrincipal: "5000000",
      action: composePerpsOrder(
        instruction,
        perpsPolicy,
        marketFixture({
          mark: "6",
          book: {
            coin: "NEAR",
            time: Date.now(),
            levels: [[{ px: "6", sz: "100", n: 1 }], [{ px: "6.01", sz: "100", n: 1 }]],
          },
        }),
        crypto.randomUUID(),
        0n,
        400n,
      ).action,
    });
    const result = accountPerpsFills(
      saved,
      positionState("2", "19.3946"),
      [fill({ side: "A", startPosition: "4", px: "6", closedPnl: "2", fee: "0.0054" })],
      new Map([[100, parentOrder(saved.action)]]),
      50,
    );
    expect(result).toMatchObject({
      quantity: 200n,
      collateral: 2500000n,
      debit: 0n,
      credit: 4494600n,
      risk: 12005400n,
    });
  });
  it("retains an overlapping entry/partial native exit until the final remaining size can be established", () => {
    const saved = orderFixture(),
      parent = parentOrder(saved.action);
    const stop: HlOrder = { ...parent, b: false, r: true, p: "3.9", c: `0x${"2".repeat(32)}` };
    const fills = [
      fill(),
      fill({ oid: 101, tid: 2, side: "A", startPosition: "2", sz: "1", px: "4", fee: "0.0018" }),
    ];
    expect(
      accountPerpsFills(
        saved,
        positionState("1", "17.64595"),
        fills,
        new Map([
          [100, parent],
          [101, stop],
        ]),
        50,
      ),
    ).toBeNull();
  });
  it("rejects fill gaps, unknown orders, bad bounds, oversized entries, fees and flipped exits", () => {
    const saved = orderFixture(),
      parent = parentOrder(saved.action),
      known = new Map([[100, parent]]);
    expect(() =>
      accountPerpsFills(saved, positionState("2", "17.4"), [fill({ startPosition: "1" })], known, 50),
    ).toThrow();
    expect(() =>
      accountPerpsFills(saved, positionState("2", "17.4"), [fill({ oid: 101 })], known, 50),
    ).toThrow();
    expect(() =>
      accountPerpsFills(saved, positionState("2", "17.4"), [fill({ px: "6" })], known, 50),
    ).toThrow();
    expect(() =>
      accountPerpsFills(saved, positionState("5", "13"), [fill({ sz: "5" })], known, 50),
    ).toThrow();
    expect(() =>
      accountPerpsFills(saved, positionState("2", "17.4"), [fill({ fee: "1" })], known, 50),
    ).toThrow();
    const stop: HlOrder = { ...parent, b: false, r: true, p: "3.9" };
    const exit = orderFixture({
      role: "exit",
      beforeExposureUnits: "100",
      action: { type: "order", orders: [stop], grouping: "na" },
    });
    expect(() =>
      accountPerpsFills(
        exit,
        positionState("-1", "20"),
        [fill({ side: "A", startPosition: "1", px: "4" })],
        new Map([[100, stop]]),
        50,
      ),
    ).toThrow();
  });
  it("recognizes forced liquidation only with account or isolated-ledger corroboration", () => {
    const saved = orderFixture({
      role: "exit",
      beforeExposureUnits: "200",
      beforeCollateralUnits: "2495500",
      beforeCollateralPrincipal: "2495500",
      beforeCashUnits: "17400000",
    });
    const forced = fill({
      oid: 999,
      side: "A",
      startPosition: "2",
      px: "0.5",
      fee: "0.1",
      liquidation: { method: "backstop", liquidatedUser: fixtureAddress },
    });
    const identified = corroboratePerpsLiquidations(saved, [forced], [], new Map());
    expect(identified.forced.has(999)).toBe(true);
    // The retrospective reduce wire is for accounting only; no price or fee guarantee applies to forced liquidation.
    const exit = orderFixture({
      ...saved,
      action: { type: "order", orders: [...identified.known.values()], grouping: "na" },
    });
    expect(
      accountPerpsFills(exit, positionState("0", "17.4"), [forced], identified.known, 50, identified.forced)
        ?.quantity,
    ).toBe(0n);
    expect(() => corroboratePerpsLiquidations(saved, [fill({ oid: 999 })], [], new Map())).toThrow();
    expect(() =>
      corroboratePerpsLiquidations(
        saved,
        [{ ...forced, liquidation: { method: "market", liquidatedUser: `0x${"2".repeat(40)}` } }],
        [],
        new Map(),
      ),
    ).toThrow();
    const ledger: IsolatedLiquidation[] = [
      {
        hash: forced.hash,
        time: forced.time,
        delta: { type: "liquidation", leverageType: "Isolated", liquidatedPositions: [{ coin: "NEAR" }] },
      },
    ];
    expect(
      corroboratePerpsLiquidations(
        saved,
        [{ ...forced, liquidation: { method: "market" } }],
        ledger,
        new Map(),
      ).forced.has(999),
    ).toBe(true);
  });
});
