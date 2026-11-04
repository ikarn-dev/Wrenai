import { accountFixture, marketFixture } from "@tests/server/execution/hyperliquid/fixtures";
import { z } from "zod";
import type { HlAction, HlOrder } from "@/server/execution/hyperliquid/contracts";
import { hlText, hlUnits } from "@/server/execution/hyperliquid/decimal";
import type { HlFunding } from "@/server/execution/hyperliquid/funding-observation";
import type { HlFill } from "@/server/execution/hyperliquid/observations";

interface VenueOrder {
  readonly wire: HlOrder;
  readonly oid: number;
  status: "open" | "filled" | "canceled";
}
/** Deterministic provider model, never imported by app code or connected to a network. */
export class OfflinePerpsVenue {
  cash = 0n;
  quantity = 0n;
  collateral = 0n;
  time = Date.now() - 100;
  readonly orders = new Map<string, VenueOrder>();
  readonly fills: HlFill[] = [];
  readonly funding: HlFunding[] = [];
  entryCalls = 0;
  protectionCalls = 0;
  loseEntryAck = false;
  noEntryFill = false;
  #leverage = 4;
  #bump(): void {
    this.time = Math.max(Date.now(), this.time + 100);
  }
  #store(wire: HlOrder, status: VenueOrder["status"]): VenueOrder {
    if (!wire.c || this.orders.has(wire.c)) {
      throw new Error("Duplicate or missing fixture cloid.");
    }
    const row = { wire, status, oid: 100 + this.orders.size };
    this.orders.set(wire.c, row);
    return row;
  }
  info(body: Readonly<Record<string, unknown>>): unknown {
    const input = z
      .object({
        type: z.string(),
        user: z.string().optional(),
        startTime: z.number().optional(),
        endTime: z.number().optional(),
        oid: z.string().optional(),
      })
      .parse(body);
    const type = input.type,
      market = marketFixture();
    if (type === "clearinghouseState") {
      const state = accountFixture(hlText(this.cash, 6));
      return {
        ...state,
        time: this.time,
        marginSummary: { ...state.marginSummary, accountValue: hlText(this.cash + this.collateral, 6) },
        assetPositions:
          this.quantity === 0n
            ? []
            : [
                {
                  type: "oneWay",
                  position: {
                    coin: "NEAR",
                    szi: hlText(this.quantity, 2),
                    entryPx: "5",
                    marginUsed: hlText(this.collateral, 6),
                    positionValue: "10",
                    unrealizedPnl: "0",
                    leverage: { type: "isolated", value: this.#leverage, rawUsd: "-7.5045" },
                  },
                },
              ],
      };
    }
    if (type === "metaAndAssetCtxs") {
      const universe = Array.from({ length: 8 }, (_, index) => ({
        name: index === 7 ? "NEAR" : `ASSET${index}`,
        szDecimals: 2,
        maxLeverage: 20,
      }));
      return [
        { universe, marginTables: [] },
        universe.map(() => ({ markPx: "5", oraclePx: "5", funding: "0.00001" })),
      ];
    }
    if (type === "l2Book") {
      return market.book;
    }
    if (type === "userFees") {
      return { userCrossRate: "0.00045" };
    }
    if (type === "activeAssetData") {
      return {
        user: z.string().parse(input.user),
        coin: "NEAR",
        leverage: { type: "isolated", value: this.#leverage },
        markPx: "5",
      };
    }
    if (type === "userNonFundingLedgerUpdates") {
      return [];
    }
    if (type === "userFunding") {
      const start = z.number().parse(input.startTime),
        end = z.number().parse(input.endTime);
      return this.funding.filter((row) => row.time >= start && row.time <= end);
    }
    if (type === "userFillsByTime") {
      const start = z.number().parse(input.startTime),
        end = z.number().parse(input.endTime);
      return this.fills.filter((fill) => fill.time >= start && fill.time <= end);
    }
    if (type === "frontendOpenOrders") {
      return [...this.orders.values()]
        .filter((order) => order.status === "open")
        .map(({ oid, wire }) => ({
          oid,
          coin: "NEAR",
          side: wire.b ? "B" : "A",
          sz: wire.s,
          origSz: wire.s,
          limitPx: wire.p,
          triggerPx: "trigger" in wire.t ? wire.t.trigger.triggerPx : "0",
          isTrigger: "trigger" in wire.t,
          reduceOnly: wire.r,
          cloid: wire.c,
        }));
    }
    if (type === "orderStatus") {
      const order = this.orders.get(z.string().parse(input.oid));
      return order
        ? {
            status: "order",
            order: {
              status: order.status,
              statusTimestamp: this.time,
              order: {
                oid: order.oid,
                coin: "NEAR",
                side: order.wire.b ? "B" : "A",
                sz: "0",
                origSz: order.wire.s,
                limitPx: order.wire.p,
                cloid: order.wire.c,
              },
            },
          }
        : { status: "unknownOid" };
    }
    throw new Error(`Unexpected offline venue read: ${type}`);
  }
  exchange(action: HlAction): unknown {
    if (action.type === "updateLeverage") {
      this.#leverage = action.leverage;
      return { status: "ok", response: { type: "default" } };
    }
    if (action.type === "cancelByCloid") {
      for (const cancel of action.cancels) {
        const order = this.orders.get(cancel.cloid);
        if (order?.status === "open") {
          order.status = "canceled";
        }
      }
      return { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
    }
    const parent = action.orders[0];
    if (!parent) {
      throw new Error("Missing fixture order.");
    }
    this.#bump();
    if (!parent.r) {
      this.entryCalls += 1;
      const row = this.#store(parent, "canceled");
      if (!this.noEntryFill) {
        this.quantity = 200n;
        this.cash -= 2_500_000n;
        this.collateral = 2_495_500n;
        this.fills.push({
          coin: "NEAR",
          px: "5",
          sz: "2",
          startPosition: "0",
          closedPnl: "0",
          side: "B",
          hash: `0x${"a".repeat(64)}`,
          oid: row.oid,
          tid: 1,
          time: this.time,
          fee: "0.0045",
          feeToken: "USDC",
        });
      }
      // A partially filled IOC leaves its parent-group children inactive, matching the venue's documented behavior.
      if (this.loseEntryAck) {
        throw new Error("Offline acknowledged request lost after the fill");
      }
    } else {
      this.protectionCalls += 1;
      for (const order of action.orders) {
        this.#store(order, "open");
      }
    }
    return { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 100 } }] } } };
  }
  closeWithNativeStop(): void {
    const row = [...this.orders.values()].find(
      (order) => order.status === "open" && "trigger" in order.wire.t && order.wire.t.trigger.tpsl === "sl",
    );
    if (!row || this.quantity !== 200n) {
      throw new Error("Missing owned protected fixture position.");
    }
    this.#bump();
    this.quantity = 0n;
    this.cash += this.collateral - 2_003_600n;
    this.collateral = 0n;
    this.fills.push({
      coin: "NEAR",
      px: "4",
      sz: "2",
      startPosition: "2",
      closedPnl: "-2",
      side: "A",
      hash: `0x${"b".repeat(64)}`,
      oid: row.oid,
      tid: 2,
      time: this.time,
      fee: "0.0036",
      feeToken: "USDC",
    });
    for (const order of this.orders.values()) {
      order.status = order === row ? "filled" : "canceled";
    }
  }
  advanceObservationTime(): void {
    this.#bump();
  }
  recordFunding(units: bigint, location: "cash" | "collateral"): void {
    this.#bump();
    if (location === "cash") {
      this.cash += units;
    } else {
      this.collateral += units;
    }
    this.funding.push({
      time: this.time,
      hash: `0x${this.funding.length.toString(16).padStart(64, "0")}`,
      delta: { type: "funding", coin: "NEAR", szi: hlText(this.quantity, 2), usdc: hlText(units, 6) },
    });
  }
  fund(): void {
    this.cash = 19_900_000n;
    this.#bump();
  }
  cashText(): string {
    return hlText(this.cash, 6);
  }
  ownedQuantity(): bigint {
    return hlUnits(hlText(this.quantity, 2), 2);
  }
}
