import { createSecretKey } from "node:crypto";
import { perpsTestContext } from "@tests/server/execution/hyperliquid/db-context";
import { OfflinePerpsVenue } from "@tests/server/execution/hyperliquid/provider-fixture";
import { observeInventory } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentRuntimes, agents } from "@/server/db/agent-schema";
import { defiPositions, executionReceipts } from "@/server/db/defi-schema";
import { delegatedKeys } from "@/server/db/schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { planPerpsCheck } from "@/server/engine/perps-check";
import { initialPerpsState } from "@/server/engine/perps-state";
import { privateTokenId } from "@/server/execution/confidential-intents";
import { type HlAction, perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { readHlRequest } from "@/server/execution/hyperliquid/journal";
import { preparePerpsExecution } from "@/server/execution/hyperliquid/orders";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { preparePerpsFunding } from "@/server/execution/perps-funding-order";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { ownedLedgerAction } from "@/server/execution/records";
import { readPortfolioPerformance } from "@/server/portfolio/performance";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { revokeTradingAccounts } from "@/server/trading-accounts/vault";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => ({
  ...(await original<typeof import("@defuse-protocol/one-click-sdk-typescript")>()),
  verifyQuoteSignature: () => true,
}));
const provider = vi.hoisted(() => ({ request: vi.fn(), info: vi.fn(), exchange: vi.fn() }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: provider.request,
}));
vi.mock("@/server/execution/hyperliquid/transport", () => ({
  hlInfo: provider.info,
  hlExchange: provider.exchange,
}));
let context: Awaited<ReturnType<typeof perpsTestContext>>;
let venue: OfflinePerpsVenue;
let rawQuote: unknown;
let privateUnits: string;
let terminal = false;
beforeEach(async () => {
  context = await perpsTestContext();
  venue = new OfflinePerpsVenue();
  privateUnits = "20000000";
  terminal = false;
  provider.info
    .mockReset()
    .mockImplementation(async (body: Readonly<Record<string, unknown>>) => venue.info(body));
  provider.exchange.mockReset().mockImplementation(async (action: HlAction) => venue.exchange(action));
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation((db) => observeInventory(db, "confidential", privateUnits));
  const deadline = Date.now() + 86_400_000,
    nonce = Buffer.alloc(32);
  Buffer.from([86, 40, 246, 198, 0, 225, 16, 243, 23]).copy(nonce);
  nonce.writeBigUInt64LE(BigInt(deadline) * 1_000_000n, 9);
  provider.request.mockReset().mockImplementation(async (path: string, body: unknown) => {
    if (path === "/v0/quote") {
      rawQuote = {
        correlationId: "offline-bridge",
        timestamp: new Date().toISOString(),
        signature: "offline-signed-quote",
        quoteRequest: body,
        quote: {
          amountIn: "20000000",
          minAmountIn: "20000000",
          amountOut: "1990000000",
          minAmountOut: "1990000000",
          amountInFormatted: "20",
          amountOutFormatted: "19.9",
          amountInUsd: "20",
          amountOutUsd: "19.9",
          timeEstimate: 1,
          depositAddress: "a".repeat(64),
          deadline: new Date(deadline).toISOString(),
        },
      };
      return rawQuote;
    }
    if (path === "/v0/generate-intent") {
      return {
        correlationId: "offline",
        intent: {
          standard: "nep413",
          payload: {
            recipient: "intents.far",
            nonce: nonce.toString("base64"),
            message: JSON.stringify({
              signer_id: "owner.near",
              deadline: new Date(deadline).toISOString(),
              intents: [
                {
                  intent: "transfer",
                  receiver_id: "a".repeat(64),
                  tokens: { [privateTokenId(context.instruction.collateralAssetId)]: "20000000" },
                },
              ],
            }),
          },
        },
      };
    }
    if (path === "/v0/submit-intent") {
      privateUnits = "0";
      return { intentHash: "1".repeat(44), correlationId: "offline-transfer" };
    }
    throw new Error("Unexpected offline provider request.");
  });
  vi.stubEnv("ONECLICK_JWT", "offline-provider-credential");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (!String(url).startsWith("https://1click.chaindefuser.com/v0/status?")) {
        throw new Error("Unexpected external request in offline test.");
      }
      return Response.json({
        quoteResponse: rawQuote,
        status: terminal ? "SUCCESS" : "PROCESSING",
        updatedAt: new Date().toISOString(),
        swapDetails: {
          intentHashes: ["1".repeat(44)],
          ...(terminal
            ? {
                amountIn: "20000000",
                amountOut: "1990000000",
                depositedAmount: "20000000",
                refundedAmount: "0",
                amountInUsd: "20",
                amountOutUsd: "19.9",
              }
            : {}),
        },
      });
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await context.postgres.close();
});
async function funding(): Promise<void> {
  const id = crypto.randomUUID();
  await context.db
    .update(agentRuntimes)
    .set({ strategyStateJson: JSON.stringify({ ...initialPerpsState, pendingSlot: id }) })
    .where(eq(agentRuntimes.agentId, context.agentId));
  const action = await preparePerpsFunding(context.db, "owner", context.agentId, 1, id);
  await advanceLedgerAction(context.db, "owner", action.id);
  terminal = true;
  venue.fund();
  await advanceLedgerAction(context.db, "owner", action.id);
  expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
}
async function entry(): Promise<string> {
  const id = crypto.randomUUID();
  await context.db
    .update(agentRuntimes)
    .set({ strategyStateJson: JSON.stringify({ ...initialPerpsState, phase: "entry", pendingSlot: id }) })
    .where(eq(agentRuntimes.agentId, context.agentId));
  const action = await preparePerpsExecution(context.db, "owner", context.agentId, 1, id);
  await advanceLedgerAction(context.db, "owner", action.id);
  return action.id;
}
describe("offline Perps funding, partial entries, native protection and recovery", () => {
  it("funds the derived address, repairs partial-entry protection and records the actual exposure", async () => {
    await funding();
    expect((await readPortfolioPerformance(context.db, "owner")).count).toBe(0);
    const id = await entry();
    expect(venue.entryCalls).toBe(1);
    expect(venue.protectionCalls).toBe(1);
    await advanceLedgerAction(context.db, "owner", id);
    expect((await ownedLedgerAction(context.db, "owner", id)).status).toBe("settled");
    expect(
      (await context.db.select().from(defiPositions)).find((position) => position.kind === "perp_long")
        ?.quantityUnits,
    ).toBe(200n);
    expect(venue.ownedQuantity()).toBe(200n);
    expect((await readPortfolioPerformance(context.db, "owner")).totalMicroUsd).toBe(-4500n);
    const quoteRequest = z
      .object({
        quoteRequest: z.object({
          recipient: z.string(),
          recipientType: z.string(),
          destinationAsset: z.string(),
        }),
      })
      .parse(rawQuote).quoteRequest;
    expect(quoteRequest.recipient).toBe(context.account.perpAddress);
    expect(quoteRequest.recipientType).toBe("DESTINATION_CHAIN");
    expect(quoteRequest.destinationAsset).toContain("1cs_v1:hypercore:");
  });
  it("never sends another entry when the acknowledgement is lost or recovery is read-only", async () => {
    await funding();
    venue.loseEntryAck = true;
    const id = await entry();
    const calls = provider.exchange.mock.calls.length;
    await advanceLedgerAction(context.db, "owner", id, "reconcile_only");
    expect(provider.exchange).toHaveBeenCalledTimes(calls);
    expect(venue.entryCalls).toBe(1);
    expect((await ownedLedgerAction(context.db, "owner", id)).status).toBe("settled");
  });
  it("reconciles a native stop after key revocation without signing or losing collateral principal", async () => {
    await funding();
    const id = await entry();
    await advanceLedgerAction(context.db, "owner", id);
    await revokeTradingAccounts(context.db, "owner");
    await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    const calls = provider.exchange.mock.calls.length;
    venue.closeWithNativeStop();
    const checkpoint = await watchPerpsPosition(context.db, "owner", context.agentId, false);
    expect(checkpoint?.quantity).toBe("0");
    expect(checkpoint?.collateralPrincipal).toBe("0");
    expect(provider.exchange).toHaveBeenCalledTimes(calls);
    expect(venue.cashText()).toBe("17.8919");
    expect(await context.db.select().from(executionReceipts)).toHaveLength(3);
    expect((await readPortfolioPerformance(context.db, "owner")).totalMicroUsd).toBe(-2008100n);
  });
  it.each(["cash", "collateral"] as const)(
    "records confirmed %s funding after revocation without a new order",
    async (location) => {
      await funding();
      const id = await entry();
      await advanceLedgerAction(context.db, "owner", id);
      await revokeTradingAccounts(context.db, "owner");
      await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
      const calls = provider.exchange.mock.calls.length;
      venue.recordFunding(-1000n, location);
      const checkpoint = await watchPerpsPosition(context.db, "owner", context.agentId, false);
      expect(checkpoint?.quantity).toBe("200");
      expect(checkpoint?.collateral).toBe(location === "collateral" ? "2494500" : "2495500");
      expect((await readPortfolioPerformance(context.db, "owner")).totalMicroUsd).toBe(-5500n);
      expect(provider.exchange).toHaveBeenCalledTimes(calls);
      await watchPerpsPosition(context.db, "owner", context.agentId, false);
      expect(await context.db.select().from(executionReceipts)).toHaveLength(3);
    },
  );
  it("stops after three unconfirmed protection attempts and still records the already filled position", async () => {
    await funding();
    provider.exchange.mockImplementation(async (action: HlAction) => {
      const result = venue.exchange(action);
      if (action.type === "order" && action.orders[0]?.r) {
        for (const order of venue.orders.values()) {
          if (order.status === "open") {
            order.status = "canceled";
          }
        }
      }
      return result;
    });
    const id = await entry();
    await advanceLedgerAction(context.db, "owner", id);
    await advanceLedgerAction(context.db, "owner", id);
    await advanceLedgerAction(context.db, "owner", id);
    expect(venue.protectionCalls).toBe(3);
    expect((await ownedLedgerAction(context.db, "owner", id)).status).toBe("settled");
    const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId)).limit(1);
    expect(agent).toMatchObject({ status: "error" });
    expect(agent?.reason).toContain("could not be confirmed");
    expect(
      (await context.db.select().from(defiPositions)).find((position) => position.kind === "perp_long")
        ?.quantityUnits,
    ).toBe(200n);
    await advanceLedgerAction(context.db, "owner", id, "reconcile_only");
    expect(venue.entryCalls).toBe(1);
    expect(venue.protectionCalls).toBe(3);
  });
  it("releases a proven zero-fill IOC only after its submission window and a complete unchanged account snapshot", async () => {
    await funding();
    venue.noEntryFill = true;
    const id = await entry();
    const action = await ownedLedgerAction(context.db, "owner", id),
      request = await readHlRequest(context.db, action, "trade");
    if (!request) {
      throw new Error("Missing committed venue request.");
    }
    expect(action.reservationReleasedAt).toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(request.expiresAfter + 1000);
    venue.advanceObservationTime();
    await advanceLedgerAction(context.db, "owner", id, "reconcile_only");
    expect((await ownedLedgerAction(context.db, "owner", id)).reservationReleasedAt).not.toBeNull();
    expect(venue.entryCalls).toBe(1);
    expect(await context.db.select().from(defiPositions)).toHaveLength(0);
  });
  it.each([
    { debit: "0", output: "0", refund: "20000000", cash: 0n, inputUsd: "0", outputUsd: "0" },
    {
      debit: "10000000",
      output: "995000000",
      refund: "10000000",
      cash: 9950000n,
      inputUsd: "10",
      outputUsd: "9.95",
    },
  ])(
    "retains a $refund funding refund and stops before any additional conversion",
    async ({ debit, output, refund, cash, inputUsd, outputUsd }) => {
      const id = crypto.randomUUID();
      await context.db
        .update(agentRuntimes)
        .set({ strategyStateJson: JSON.stringify({ ...initialPerpsState, pendingSlot: id }) })
        .where(eq(agentRuntimes.agentId, context.agentId));
      const action = await preparePerpsFunding(context.db, "owner", context.agentId, 1, id);
      await advanceLedgerAction(context.db, "owner", action.id);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            quoteResponse: rawQuote,
            status: "REFUNDED",
            updatedAt: new Date().toISOString(),
            swapDetails: {
              amountIn: debit,
              amountOut: output,
              depositedAmount: "20000000",
              refundedAmount: refund,
              amountInUsd: inputUsd,
              amountOutUsd: outputUsd,
              intentHashes: ["1".repeat(44)],
            },
          }),
        ),
      );
      privateUnits = refund;
      venue.cash = cash;
      venue.advanceObservationTime();
      await advanceLedgerAction(context.db, "owner", action.id);
      expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
      expect(
        await unreservedOwnedUnits(
          context.db,
          "owner",
          context.agentId,
          "confidential",
          context.instruction.collateralAssetId,
        ),
      ).toBe(BigInt(refund));
      expect(
        await unreservedOwnedUnits(
          context.db,
          "owner",
          context.agentId,
          "hyperliquid",
          perpsCashAssetId(context.account.perpAddress),
        ),
      ).toBe(cash);
      const [runtime] = await context.db
        .select()
        .from(agentRuntimes)
        .where(eq(agentRuntimes.agentId, context.agentId))
        .limit(1);
      if (!runtime) {
        throw new Error("Missing funded agent runtime.");
      }
      const next = await planPerpsCheck(context.db, runtime, context.instruction);
      expect(next.progress?.completed).toBe(true);
      expect(next.perpsRequest).toBeUndefined();
      expect(venue.entryCalls).toBe(0);
    },
  );
});
