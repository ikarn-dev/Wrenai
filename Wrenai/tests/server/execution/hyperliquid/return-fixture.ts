import { accountFixture, fixtureAsset } from "@tests/server/execution/hyperliquid/fixtures";
import { z } from "zod";
import { hlText, hlUnits } from "@/server/execution/hyperliquid/decimal";
import type { IntentToken } from "@/server/research/intents";
import type { HlUsdSend } from "@/shared/perps-return";

export const returnToken: IntentToken = {
  assetId: fixtureAsset,
  symbol: "USDC",
  decimals: 6,
  blockchain: "near",
  contractAddress: fixtureAsset.slice(7),
};
export const depositAddress = "0x2222222222222222222222222222222222222222";
export const originHash = `0x${"a".repeat(64)}`;
/** Whole provider model for withdrawal tests; no network or real account is used. */
export class OfflineReturnVenue {
  cash = 10_000_000n;
  privateUnits = "20000000";
  quote: unknown = null;
  pending = true;
  lostAck = false;
  positionOpen = false;
  orderOpen = false;
  transferCalls = 0;
  request: HlUsdSend | null = null;
  refund = 0n;
  output = 8_800_000n;
  badHash = false;
  wrongMoney = false;
  completedAt = 0;
  makeQuote(body: unknown): unknown {
    const input = z.object({ amount: z.string() }).parse(body),
      units = BigInt(input.amount) / 100n - 200_000n;
    this.quote = {
      correlationId: "offline-return",
      signature: "offline-signature",
      timestamp: new Date().toISOString(),
      quoteRequest: body,
      quote: {
        amountIn: input.amount,
        minAmountIn: input.amount,
        amountOut: units.toString(),
        minAmountOut: ((units * 9950n) / 10000n).toString(),
        amountInFormatted: hlText(BigInt(input.amount), 8),
        amountOutFormatted: hlText(units, 6),
        amountInUsd: hlText(BigInt(input.amount), 8),
        amountOutUsd: hlText(units, 6),
        timeEstimate: 1,
        depositAddress,
        deadline: new Date(Date.now() + 120_000).toISOString(),
      },
    };
    return this.quote;
  }
  transfer(action: HlUsdSend): unknown {
    this.transferCalls += 1;
    if (this.request) {
      throw new Error("Attempted duplicate fixture transfer.");
    }
    this.request = action;
    this.cash -= hlUnits(action.amount, 6);
    if (this.lostAck) {
      throw new Error("Acknowledgement lost after transfer");
    }
    return { status: "ok", response: { type: "default" } };
  }
  info(body: Readonly<Record<string, unknown>>): unknown {
    const { type, user } = z.object({ type: z.string(), user: z.string().optional() }).parse(body);
    if (type === "clearinghouseState") {
      const state = accountFixture(hlText(this.cash, 6));
      return {
        ...state,
        assetPositions: this.positionOpen
          ? [
              {
                type: "oneWay",
                position: {
                  coin: "NEAR",
                  szi: "1",
                  entryPx: "5",
                  marginUsed: "2",
                  positionValue: "5",
                  unrealizedPnl: "0",
                  leverage: { type: "isolated", value: 4 },
                },
              },
            ]
          : [],
      };
    }
    if (type === "frontendOpenOrders") {
      return this.orderOpen
        ? [
            {
              coin: "NEAR",
              oid: 1,
              side: "A",
              sz: "1",
              origSz: "1",
              limitPx: "4",
              triggerPx: "4",
              isTrigger: true,
              reduceOnly: true,
            },
          ]
        : [];
    }
    if (type === "userFillsByTime") {
      return [];
    }
    if (type === "userNonFundingLedgerUpdates") {
      if (!this.request) {
        return [];
      }
      return [
        {
          time: String(this.request.time),
          hash: originHash,
          delta: {
            type: "internalTransfer",
            usdc: this.wrongMoney ? "8" : "9",
            fee: "1",
            user: z.string().parse(user),
            destination: this.request.destination,
          },
        },
        ...(this.refund > 0n
          ? [
              {
                time: String(this.completedAt),
                hash: `0x${"b".repeat(64)}`,
                delta: {
                  type: "internalTransfer",
                  usdc: hlText(this.refund / 100n, 6),
                  fee: "0",
                  user: depositAddress,
                  destination: z.string().parse(user),
                },
              },
            ]
          : []),
      ];
    }
    throw new Error(`Unexpected return fixture read: ${type}`);
  }
  status(): unknown {
    return {
      quoteResponse: this.quote,
      status: this.pending ? "PROCESSING" : this.refund > 0n ? "REFUNDED" : "SUCCESS",
      updatedAt: new Date().toISOString(),
      swapDetails: {
        amountIn: (900_000_000n - this.refund).toString(),
        amountOut: this.output.toString(),
        amountInUsd: hlText(9_000_000n - this.refund / 100n, 6),
        amountOutUsd: hlText(this.output, 6),
        depositedAmount: "900000000",
        refundedAmount: this.refund.toString(),
        originChainTxHashes: [{ hash: this.badHash ? `0x${"c".repeat(64)}` : originHash }],
        intentHashes: this.output > 0n ? ["offline-private-output"] : [],
      },
    };
  }
  complete(refund = 0n, output = 8_800_000n): void {
    this.pending = false;
    this.completedAt = Date.now();
    this.refund = refund;
    this.output = output;
    this.cash += refund / 100n;
    this.privateUnits = (20_000_000n + output).toString();
  }
}
