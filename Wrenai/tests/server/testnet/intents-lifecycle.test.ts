import { randomUUID } from "node:crypto";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/testnet/rpc", async () => ({
  ...(await vi.importActual<typeof import("@/server/testnet/rpc")>("@/server/testnet/rpc")),
  testnetChain: vi.fn(async () => undefined),
  testnetBalance: vi.fn(async () => 10n ** 26n),
  testnetRpc: vi.fn(),
}));
vi.mock("@/server/testnet/intents", () => ({
  locatedBalance: vi.fn(async () => 100000000n),
  publicIntentsTransfer: vi.fn(async (_account: string, asset: string, units: string, recipient: string) => ({
    receiverId: "verifier.tidepool-sandbox.testnet",
    method: "mt_transfer",
    deposit: "1",
    gas: "50000000000000",
    args: { receiver_id: recipient, token_id: asset, amount: units },
  })),
}));
vi.mock("@/server/testnet/provider", async () => ({
  ...(await vi.importActual<typeof import("@/server/testnet/provider")>("@/server/testnet/provider")),
  testnetQuote: vi.fn(),
  tidepool: vi.fn(),
}));

import { claimTestnetAgent } from "@/server/testnet/agent-controls";
import { stopTestnetAgent } from "@/server/testnet/agents";
import { testnetCipher, testnetEnv } from "@/server/testnet/config";
import { locatedBalance } from "@/server/testnet/intents";
import { confirmTestnetOrder, openPlan, ownedOrder, quoteTestnetOrder } from "@/server/testnet/orders";
import { changeBalance, ownedBalance, poolTransaction } from "@/server/testnet/pool";
import { type TideQuote, testnetQuote, tidepool, VERIFIER } from "@/server/testnet/provider";
import { reconcileStage, reconcileSwap } from "@/server/testnet/reconcile";
import { testnetRpc } from "@/server/testnet/rpc";
import { tnAgents, tnOrders, tnSubmissions } from "@/server/testnet/schema";
import { signPoolStage } from "@/server/testnet/signing";
import { testnetSnapshot } from "@/server/testnet/snapshot";
import { type TestnetIntent, testnetAsset } from "@/shared/testnet";
import { testnetContext, USDC, USDT } from "./context";

let c: Awaited<ReturnType<typeof testnetContext>>;
const deposit = "deposit.testnet";
function quote(): TideQuote {
  return {
    correlationId: "public-intents",
    timestamp: new Date().toISOString(),
    signature: "verified-by-boundary-test",
    quoteRequest: {
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: 49,
      originAsset: USDC,
      destinationAsset: USDT,
      amount: "1000000",
      depositType: QuoteRequest.depositType.INTENTS,
      refundType: QuoteRequest.refundType.INTENTS,
      recipientType: QuoteRequest.recipientType.INTENTS,
      refundTo: testnetEnv().TESTNET_POOL_ACCOUNT_ID,
      recipient: testnetEnv().TESTNET_POOL_ACCOUNT_ID,
      deadline: new Date(Date.now() + 120000).toISOString(),
    },
    quote: {
      amountIn: "1000000",
      minAmountIn: "1000000",
      amountOut: "997000",
      minAmountOut: "992015",
      amountInFormatted: "1",
      amountOutFormatted: "0.997",
      amountInUsd: "1",
      amountOutUsd: "0.997",
      timeEstimate: 10,
      depositAddress: deposit,
    },
  };
}
function receipt(hash: string, signer: string, receiver: string, logs: string[], actions: unknown[]) {
  const outcome = { executor_id: receiver, logs, status: { SuccessValue: "" }, tokens_burnt: "1" };
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: { hash, signer_id: signer, receiver_id: receiver, actions },
    transaction_outcome: { outcome },
    receipts_outcome: [{ id: "receipt", outcome }],
  };
}
function credit(token: string, recipient: string, units: string): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "nep245",
    version: "1.0.0",
    event: "mt_transfer",
    data: [
      {
        old_owner_id: "maker.tidepool-sandbox.testnet",
        new_owner_id: recipient,
        token_ids: [token],
        amounts: [units],
      },
    ],
  })}`;
}
beforeEach(async () => {
  c = await testnetContext();
  vi.mocked(testnetQuote).mockResolvedValue(quote());
  await poolTransaction(c.db, async (tx) => {
    await changeBalance(tx, c.owner.id, USDC, 5000000n, 0n, "manual", "intents");
    await changeBalance(tx, c.owner.id, USDC, 3000000n, 0n);
  });
});
afterEach(async () => {
  await c.postgres.close();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("public Intents order accounting and recovery", () => {
  it("journals signed bytes before broadcast and settles the exact public transfer once", async () => {
    const intent: TestnetIntent = {
      kind: "payment",
      assetId: USDC,
      amount: "1",
      recipient: "alice.testnet",
      location: "intents",
    };
    const order = await quoteTestnetOrder(c.db, c.owner, randomUUID(), intent);
    await expect(signPoolStage(c.db, order.id)).resolves.toBeNull();
    await confirmTestnetOrder(c.db, c.owner, order.id);
    vi.mocked(testnetRpc).mockImplementation(async (method) =>
      method === "gas_price"
        ? { gas_price: "100000000" }
        : {
            nonce: "9007199254741000",
            permission: "FullAccess",
            block_hash: "11111111111111111111111111111111",
          },
    );
    const signed = await signPoolStage(c.db, order.id);
    expect(signed).not.toBeNull();
    const [journal] = await c.db.select().from(tnSubmissions);
    expect(journal?.nonce).toBe("9007199254741001");
    expect(journal?.hash).toBe(signed?.hash);
    expect(testnetCipher().open(c.owner.id, order.id, "signed:0", journal?.sealedBytes ?? "")).toBe(
      signed?.bytes,
    );
    const prepared = await ownedOrder(c.db, c.owner.id, order.id),
      call = openPlan(prepared).calls[0];
    if (!call || !signed) {
      throw new Error("Missing prepared transaction");
    }
    vi.mocked(testnetRpc).mockResolvedValue(
      receipt(
        signed.hash,
        openPlan(prepared).signer,
        VERIFIER,
        [credit(USDC, "alice.testnet", "1000000")],
        [
          {
            FunctionCall: {
              method_name: "mt_transfer",
              args: Buffer.from(JSON.stringify(call.args)).toString("base64"),
              deposit: "1",
              gas: call.gas,
            },
          },
        ],
      ),
    );
    await reconcileStage(c.db, prepared);
    await reconcileStage(c.db, prepared);
    expect((await ownedBalance(c.db, c.owner.id, USDC, "manual", "intents")).units).toBe("4000000");
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("3000000");
  });
  it.each([false, true])(
    "proves a %s refund against its original location without double credit",
    async (refund) => {
      const order = await quoteTestnetOrder(c.db, c.owner, randomUUID(), {
        kind: "swap",
        assetId: USDC,
        outputAssetId: USDT,
        amount: "1",
        slippageBps: 50,
        location: "intents",
        outputLocation: "intents",
      });
      expect(openPlan(order).calls[0]?.method).toBe("mt_transfer");
      await confirmTestnetOrder(c.db, c.owner, order.id);
      await c.db.update(tnOrders).set({ state: "submitted", step: 1 }).where(eq(tnOrders.id, order.id));
      const q = openPlan(order).quote,
        units = refund ? "1000000" : "997000",
        asset = refund ? USDC : USDT;
      vi.mocked(tidepool).mockResolvedValue({
        status: refund ? "REFUNDED" : "SUCCESS",
        quoteResponse: q,
        swapDetails: {
          amountIn: "1000000",
          amountOut: refund ? "0" : units,
          refundedAmount: refund ? units : "0",
          nearTxHashes: ["payout"],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      });
      vi.mocked(testnetRpc).mockResolvedValue(
        receipt(
          "payout",
          "maker.tidepool-sandbox.testnet",
          VERIFIER,
          [credit(asset, testnetEnv().TESTNET_POOL_ACCOUNT_ID, units)],
          [{}],
        ),
      );
      const submitted = await ownedOrder(c.db, c.owner.id, order.id);
      await reconcileSwap(c.db, submitted);
      await reconcileSwap(c.db, submitted);
      expect((await ownedBalance(c.db, c.owner.id, USDC, "manual", "intents")).units).toBe(
        refund ? "5000000" : "4000000",
      );
      expect((await ownedBalance(c.db, c.owner.id, USDT, "manual", "intents")).units).toBe(
        refund ? "0" : "997000",
      );
      expect((await ownedBalance(c.db, c.owner.id, USDT)).units).toBe("0");
    },
  );
  it("does not accept a payout to the wrong location, and retains its hold", async () => {
    const order = await quoteTestnetOrder(c.db, c.owner, randomUUID(), {
      kind: "swap",
      assetId: USDC,
      outputAssetId: USDT,
      amount: "1",
      slippageBps: 50,
      location: "intents",
      outputLocation: "intents",
    });
    await confirmTestnetOrder(c.db, c.owner, order.id);
    await c.db.update(tnOrders).set({ state: "submitted", step: 1 }).where(eq(tnOrders.id, order.id));
    vi.mocked(tidepool).mockResolvedValue({
      status: "SUCCESS",
      quoteResponse: openPlan(order).quote,
      swapDetails: { amountIn: "1000000", amountOut: "997000", nearTxHashes: ["payout"] },
    });
    vi.mocked(testnetRpc).mockResolvedValue(
      receipt("payout", "maker.tidepool-sandbox.testnet", testnetAsset(USDT).contract ?? "", [], [{}]),
    );
    await expect(reconcileSwap(c.db, await ownedOrder(c.db, c.owner.id, order.id))).rejects.toThrow(
      "not been proven",
    );
    expect((await ownedBalance(c.db, c.owner.id, USDC, "manual", "intents")).held).toBe("1000000");
  });
  it("shows only owner funds per location and returns agent funds to the original location", async () => {
    const id = randomUUID();
    await c.db.insert(tnAgents).values({
      id,
      ownerId: c.owner.id,
      requestId: randomUUID(),
      name: "DCA",
      kind: "dca",
      state: "running",
      sealedRule: testnetCipher().seal(
        c.owner.id,
        id,
        "rule",
        JSON.stringify({
          name: "DCA",
          kind: "dca",
          assetId: USDC,
          outputAssetId: USDT,
          recipient: null,
          amount: "1",
          budget: "2",
          intervalSeconds: 60,
          costBasis: null,
          thresholdBps: 500,
          expiresAt: c.owner.expiresAt,
          location: "intents",
          outputLocation: "intents",
        }),
      ),
      nextAt: Date.now(),
      expiresAt: c.owner.expiresAt,
      createdAt: Date.now(),
    });
    await poolTransaction(c.db, async (tx) => {
      await changeBalance(tx, c.owner.id, USDC, -2000000n, 0n, "manual", "intents");
      await changeBalance(tx, c.owner.id, USDC, 2000000n, 1000000n, id, "intents");
    });
    const snapshot = await testnetSnapshot(c.db, c.owner);
    expect(snapshot.balances.find((b) => b.assetId === USDC && b.location === "intents")).toMatchObject({
      units: "5000000",
      reserved: "2000000",
    });
    expect((await testnetSnapshot(c.db, c.stranger)).balances.every((b) => b.units === "0")).toBe(true);
    // Stopping keeps the agent's funds for Claims; claiming returns only its free intents units.
    await stopTestnetAgent(c.db, c.owner.id, id);
    expect((await ownedBalance(c.db, c.owner.id, USDC, "manual", "intents")).units).toBe("3000000");
    await claimTestnetAgent(c.db, c.owner.id, id);
    expect((await ownedBalance(c.db, c.owner.id, USDC, "manual", "intents")).units).toBe("4000000");
    expect((await ownedBalance(c.db, c.owner.id, USDC)).units).toBe("3000000");
    expect((await ownedBalance(c.db, c.owner.id, USDC, id, "intents")).held).toBe("1000000");
  });
  it("checks current backing before signing and never signs an underfunded pool", async () => {
    const order = await quoteTestnetOrder(c.db, c.owner, randomUUID(), {
      kind: "payment",
      assetId: USDC,
      amount: "1",
      recipient: "alice.testnet",
      location: "intents",
    });
    await confirmTestnetOrder(c.db, c.owner, order.id);
    vi.mocked(locatedBalance).mockResolvedValueOnce(1n);
    vi.mocked(testnetRpc).mockImplementation(async (method) =>
      method === "gas_price"
        ? { gas_price: "100000000" }
        : { nonce: "5", permission: "FullAccess", block_hash: "11111111111111111111111111111111" },
    );
    await expect(signPoolStage(c.db, order.id)).rejects.toThrow("backs its allocations");
    expect(await c.db.select().from(tnSubmissions)).toHaveLength(0);
  });
});
