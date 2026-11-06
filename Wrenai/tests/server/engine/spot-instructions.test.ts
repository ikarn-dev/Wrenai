import {
  baseAsset,
  cashAsset,
  instruction,
  policy,
  quote,
  snapshot,
} from "@tests/server/engine/spot-fixture";
import { describe, expect, it, vi } from "vitest";
import { instructionRequestId } from "@/server/engine/instruction-planning";
import { applySpotFill } from "@/server/engine/instruction-receipt";
import { initialInstructionState } from "@/server/engine/instruction-state";
import { decideSpotInstruction, initialSpotState, spotOrderSize } from "@/server/engine/spot-instructions";
import { observeSpotInstruction } from "@/server/engine/spot-observation";
import { MarketUnavailable } from "@/server/research/market-http";
import { agentInstructionSchema } from "@/shared/agent-instructions";

vi.mock("server-only", () => ({}));
const now = Date.parse("2026-11-02T00:00:00Z");
describe("reviewed spot instructions", () => {
  it("rejects stale, oversized and mismatched quotes before a signal", () => {
    const rule = instruction(now),
      state = initialInstructionState("spot_trader");
    expect(decideSpotInstruction(rule, policy, state, snapshot(now), now).signal?.inputUnits).toBe("1000000");
    expect(() => decideSpotInstruction(rule, policy, state, snapshot(now, { cashOwned: 1n }), now)).toThrow(
      /inventory/,
    );
    expect(() =>
      decideSpotInstruction(
        rule,
        policy,
        state,
        snapshot(now, { quote: quote(now, { expiresAt: now }) }),
        now,
      ),
    ).toThrow(/fresh/);
    expect(() =>
      decideSpotInstruction(
        rule,
        policy,
        state,
        snapshot(now, { quote: quote(now, { inputUnits: "2" }) }),
        now,
      ),
    ).toThrow(/size/);
    // Venue drift beyond the independent price waits for a later check instead of counting as a failure.
    expect(
      decideSpotInstruction(
        rule,
        policy,
        state,
        snapshot(now, { quote: quote(now, { outputUnits: "500000", minOutputUnits: "500000" }) }),
        now,
      ).signal,
    ).toBeNull();
  });
  it("requires both the observed and executable price to reach a limit", () => {
    const rule = instruction(now, { entry: { type: "price", direction: "below", price: "0.999" } }),
      state = initialInstructionState("spot_trader");
    const market = { n: 998n, d: 1000n, observedAt: now };
    expect(
      decideSpotInstruction(rule, policy, state, snapshot(now, { price: market }), now).signal,
    ).toBeNull();
    expect(() =>
      decideSpotInstruction(
        rule,
        policy,
        state,
        snapshot(now, { price: { ...market, observedAt: now - 5000 } }),
        now,
      ),
    ).toThrow(MarketUnavailable);
  });
  it("reduces only confirmed owned units even when the entry trade cap is exhausted", () => {
    const rule = instruction(now, {
      exits: { takeProfitPrice: "1.1", stopLossPrice: "0.9", trailingStopBps: 500 },
    });
    const state = {
      ...initialInstructionState("spot_trader"),
      phase: "holding" as const,
      quantityUnits: "1000000",
      runs: 1,
      lastActionId: crypto.randomUUID(),
    };
    const data = snapshot(now, {
      price: { n: 8n, d: 10n, observedAt: now },
      quote: quote(now, {
        inputAssetId: baseAsset.assetId,
        outputAssetId: cashAsset.assetId,
        inputMicroUsd: "800000",
        outputMicroUsd: "800000",
        outputUnits: "800000",
        minOutputUnits: "800000",
      }),
    });
    const result = decideSpotInstruction(rule, { ...policy, maxTradeUsd: "0.1" }, state, data, now);
    expect(result.signal).toMatchObject({ purpose: "instruction_exit", inputUnits: "1000000" });
    expect(() =>
      decideSpotInstruction(
        rule,
        { ...policy, maxTradeUsd: "0.1", allowRiskReducingExits: false },
        state,
        data,
        now,
      ),
    ).toThrow(/spending/);
    expect(() => decideSpotInstruction(rule, policy, state, { ...data, baseOwned: 999999n }, now)).toThrow(
      /inventory/,
    );
  });
  it("honors expiry retention and tracks partial protective exits", () => {
    const rule = instruction(now, { expiresAt: new Date(now + 1).toISOString() });
    const state = {
      ...initialInstructionState("spot_trader"),
      phase: "holding" as const,
      quantityUnits: "1000000",
      lastActionId: crypto.randomUUID(),
      exitTriggered: true,
    };
    expect(decideSpotInstruction(rule, policy, state, snapshot(now + 1), now + 1).state.phase).toBe(
      "completed",
    );
    const id = crypto.randomUUID();
    const partial = applySpotFill(rule, state, id, "exit", false, {
      input: 400000n,
      output: 400000n,
      occurredAt: now,
    });
    expect(partial.quantityUnits).toBe("600000");
    expect(partial.exitTriggered).toBe(true);
    expect(
      applySpotFill(rule, partial, id, "exit", false, { input: 400000n, output: 400000n, occurredAt: now })
        .quantityUnits,
    ).toBe("600000");
  });
  it("keys a DCA order to one durable slot and accumulates only confirmed output", () => {
    const rule = agentInstructionSchema.parse({
      format: 2,
      kind: "dca",
      payAssetId: cashAsset.assetId,
      buyAssetId: baseAsset.assetId,
      amountUnits: "1000000",
      priceUnit: "usd",
      expiresAt: new Date(now + 1000_000).toISOString(),
      schedule: { type: "interval", intervalSeconds: 300, startAt: new Date(now).toISOString() },
      maxRuns: 2,
      missedSlots: "skip",
    });
    if (rule.kind !== "dca") {
      throw new Error("Expected DCA");
    }
    const state = initialInstructionState("dca"),
      signal = decideSpotInstruction(rule, policy, state, snapshot(now), now).signal;
    if (!signal) {
      throw new Error("Expected scheduled signal");
    }
    expect(instructionRequestId("agent", 1, signal.instructionSlot)).toBe(
      instructionRequestId("agent", 1, signal.instructionSlot),
    );
    const next = applySpotFill(rule, state, crypto.randomUUID(), signal.instructionSlot, true, {
      input: 1000000n,
      output: 900000n,
      occurredAt: now,
    });
    expect(next.quantityUnits).toBe("900000");
    expect(next.runs).toBe(1);
    expect(spotOrderSize(rule, next, now + 5000)).toBeNull();
    expect(spotOrderSize(rule, next, now + 300000)?.units).toBe(1000000n);
  });
  it("waits for a complete rolling window and restarts confirmation after gaps", () => {
    const rule = agentInstructionSchema.parse({
      format: 2,
      kind: "buy_the_dip",
      payAssetId: cashAsset.assetId,
      buyAssetId: baseAsset.assetId,
      amountUnits: "1000000",
      priceUnit: "usd",
      expiresAt: new Date(now + 3600_000).toISOString(),
      reference: { type: "rolling_high", windowSeconds: 60, drawdownBps: 1000 },
      confirmationSeconds: 5,
      cooldownSeconds: 60,
      maxEntries: 3,
      exits: { takeProfitPrice: "1.1", stopLossPrice: "0.7", trailingStopBps: null },
    });
    if (rule.kind !== "buy_the_dip") {
      throw new Error("Expected dip");
    }
    let state = initialInstructionState("buy_the_dip");
    for (let elapsed = 0; elapsed < 60000; elapsed += 5000) {
      const result = observeSpotInstruction(rule, state, snapshot(now + elapsed), now + elapsed);
      expect(result.eligible).toBe(false);
      state = result.state;
    }
    const down = (at: number) => snapshot(at, { price: { n: 8n, d: 10n, observedAt: at } });
    const first = observeSpotInstruction(rule, state, down(now + 60000), now + 60000);
    expect(first.eligible).toBe(false);
    expect(observeSpotInstruction(rule, first.state, down(now + 65000), now + 65000).eligible).toBe(true);
    expect(observeSpotInstruction(rule, first.state, down(now + 75001), now + 75001).eligible).toBe(false);
  });
  it("protects the full remaining Top position and accounts separately for each partial target", () => {
    const rule = agentInstructionSchema.parse({
      format: 2,
      kind: "sell_the_top",
      sellAssetId: baseAsset.assetId,
      receiveAssetId: cashAsset.assetId,
      quantityUnits: "1000000",
      confirmedBasisUnits: "1000000",
      priceUnit: "usd",
      targets: [
        { profitBps: 2000, sellBps: 5000 },
        { profitBps: 4000, sellBps: 2500 },
      ],
      stopLossBps: 1000,
      trailingStopBps: 500,
      expiresAt: new Date(now + 3600_000).toISOString(),
    });
    if (rule.kind !== "sell_the_top") {
      throw new Error("Expected Top");
    }
    const state = initialSpotState(rule, initialInstructionState("sell_the_top"));
    const stop = observeSpotInstruction(
      rule,
      state,
      snapshot(now, { price: { n: 8n, d: 10n, observedAt: now } }),
      now,
    );
    expect(spotOrderSize(rule, stop.state, now)?.units).toBe(1000000n);
    const half = applySpotFill(rule, { ...state, pendingTarget: 0 }, crypto.randomUUID(), "profit", false, {
      input: 250000n,
      output: 312500n,
      occurredAt: now,
    });
    expect(half.completedTargets).toEqual([]);
    expect(half.targetSoldUnits).toEqual(["250000"]);
    expect(spotOrderSize(rule, half, now)?.units).toBe(250000n);
    const completed = applySpotFill(
      rule,
      { ...half, pendingTarget: 0 },
      crypto.randomUUID(),
      "profit",
      false,
      { input: 250000n, output: 312500n, occurredAt: now },
    );
    expect(completed.completedTargets).toEqual([0]);
    expect(completed.quantityUnits).toBe("500000");
  });
});
