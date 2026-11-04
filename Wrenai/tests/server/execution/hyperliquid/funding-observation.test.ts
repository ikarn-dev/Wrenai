import { orderFixture } from "@tests/server/execution/hyperliquid/fixtures";
import { OfflinePerpsVenue } from "@tests/server/execution/hyperliquid/provider-fixture";
import { describe, expect, it, vi } from "vitest";
import { hlAccountStateSchema } from "@/server/execution/hyperliquid/account-state";
import { perpsCheckpointSchema } from "@/server/execution/hyperliquid/checkpoint";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import {
  fundingOnlyAccounting,
  observedIsolatedCollateral,
  readHlFunding,
} from "@/server/execution/hyperliquid/funding-observation";
import { hlInfo } from "@/server/execution/hyperliquid/transport";

vi.mock("server-only", () => ({}));
vi.mock("@/server/execution/hyperliquid/transport", () => ({ hlInfo: vi.fn() }));
function observation(units: bigint, location: "cash" | "collateral") {
  const venue = new OfflinePerpsVenue();
  venue.cash = 17400000n;
  venue.collateral = 2495500n;
  venue.quantity = 200n;
  const checkpoint = perpsCheckpointSchema.parse({
    entryActionId: crypto.randomUUID(),
    time: venue.time,
    cash: "17400000",
    quantity: "200",
    collateral: "2495500",
    collateralPrincipal: "2495500",
    sequence: 0,
    watermark: "5",
    stop: "4",
    orders: [],
  });
  venue.recordFunding(units, location);
  const state = hlAccountStateSchema.parse(venue.info({ type: "clearinghouseState" })),
    cash = hlUnits(state.crossMarginSummary.totalRawUsd, 6),
    delta = cash - BigInt(checkpoint.cash);
  return {
    venue,
    checkpoint,
    state,
    base: {
      quantity: 200n,
      debit: delta < 0n ? -delta : 0n,
      credit: delta > 0n ? delta : 0n,
      collateral: 2495500n,
      risk: 0n,
      fee: 0n,
      cashAfter: cash,
    },
  };
}
describe("confirmed isolated Perps funding accounting", () => {
  it.each(["cash", "collateral"] as const)("accounts for a real funding charge in %s", (location) => {
    const { venue, checkpoint, state, base } = observation(-1000n, location);
    const result = fundingOnlyAccounting(orderFixture(), checkpoint, state, base, venue.funding);
    expect(result.risk).toBe(1000n);
    expect(result.credit - result.debit + result.collateral - BigInt(checkpoint.collateral)).toBe(-1000n);
  });
  it("recognizes actual funding income without declaring a new fill", () => {
    const { venue, checkpoint, state, base } = observation(2500n, "collateral");
    expect(fundingOnlyAccounting(orderFixture(), checkpoint, state, base, venue.funding).collateral).toBe(
      2498000n,
    );
  });
  it("rejects unexplained balance changes and funding for another position", () => {
    const { venue, checkpoint, state, base } = observation(-1000n, "cash");
    expect(() =>
      fundingOnlyAccounting(
        orderFixture(),
        checkpoint,
        state,
        { ...base, cashAfter: base.cashAfter + 1n },
        venue.funding,
      ),
    ).toThrow("beyond");
    expect(() =>
      fundingOnlyAccounting(
        orderFixture(),
        checkpoint,
        state,
        base,
        venue.funding.map((row) => ({ ...row, delta: { ...row.delta, coin: "BTC" } })),
      ),
    ).toThrow("unchanged owned");
    expect(() =>
      fundingOnlyAccounting(orderFixture(), checkpoint, state, { ...base, quantity: 201n }, venue.funding),
    ).toThrow("unchanged owned");
  });
  it("rejects collateral observations that would require rounding money", () => {
    const { state } = observation(1000n, "cash");
    expect(() =>
      observedIsolatedCollateral({
        ...state,
        marginSummary: { ...state.marginSummary, accountValue: "19.8965001" },
      }),
    ).toThrow("Exact isolated");
  });
  it("rejects duplicate, truncated and out-of-window venue histories", async () => {
    const { venue, checkpoint, state } = observation(-1000n, "cash"),
      row = venue.funding[0];
    if (!row) {
      throw new Error("Missing funding fixture.");
    }
    for (const rows of [
      [row, row],
      Array.from({ length: 200 }, (_, index) => ({
        ...row,
        hash: `0x${index.toString(16).padStart(64, "0")}`,
      })),
      [{ ...row, time: checkpoint.time }],
    ]) {
      vi.mocked(hlInfo).mockResolvedValueOnce(rows);
      await expect(readHlFunding(orderFixture().address, checkpoint.time + 1, state.time)).rejects.toThrow(
        "incomplete or inconsistent",
      );
    }
  });
});
