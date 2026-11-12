import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/testnet/rpc", async () => {
  const original = await vi.importActual<typeof import("@/server/testnet/rpc")>("@/server/testnet/rpc");
  return {
    ...original,
    testnetChain: vi.fn(async () => undefined),
    testnetBalance: vi.fn(async () => 10n ** 26n),
    testnetRpc: vi.fn(),
  };
});

import { expireTestnetGuest, GUEST_RETENTION_MS, reclaimAbandonedGuests } from "@/server/testnet/expiry";
import { confirmTestnetOrder, openPlan, ownedOrder } from "@/server/testnet/orders";
import { changeBalance, grantGuest, ownedBalance, poolTransaction } from "@/server/testnet/pool";
import { reconcileStage } from "@/server/testnet/reconcile";
import { testnetRpc } from "@/server/testnet/rpc";
import { tnOrders, tnOwners } from "@/server/testnet/schema";
import { queuedPayment, testnetContext, USDC } from "./context";

let c: Awaited<ReturnType<typeof testnetContext>>;
beforeEach(async () => {
  c = await testnetContext();
});
afterEach(async () => {
  await c.postgres.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("testnet order lifecycle", () => {
  it("confirms exactly once and never reserves another owner's units", async () => {
    const { db, owner } = c;
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 2000000n, 0n));
    const order = await queuedPayment(db, owner);
    await db.update(tnOrders).set({ state: "review", confirmedAt: null }).where(eq(tnOrders.id, order.id));
    await confirmTestnetOrder(db, owner, order.id);
    await confirmTestnetOrder(db, owner, order.id);
    expect((await ownedBalance(db, owner.id, USDC)).held).toBe("1000000");
    await expect(confirmTestnetOrder(db, c.stranger, order.id)).rejects.toThrow("session");
  });
  it("rejects expired cards without reserving input", async () => {
    const { db, owner } = c;
    const order = await queuedPayment(db, owner);
    await db
      .update(tnOrders)
      .set({ state: "review", confirmedAt: null, expiresAt: Date.now() - 1 })
      .where(eq(tnOrders.id, order.id));
    await expect(confirmTestnetOrder(db, owner, order.id)).rejects.toThrow("expired");
    expect((await ownedBalance(db, owner.id, USDC)).held).toBe("0");
  });
  it("commits a proven payment once, even if reconciliation is repeated", async () => {
    const { db, owner } = c;
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 2000000n, 1000000n));
    const order = await queuedPayment(db, owner);
    const call = openPlan(order).calls[0];
    if (!call) {
      throw new Error("Missing call");
    }
    const outcome = {
      executor_id: call.receiverId,
      logs: [],
      status: { SuccessValue: "" },
      tokens_burnt: "1",
    };
    vi.mocked(testnetRpc).mockResolvedValue({
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction: {
        hash: "hash",
        signer_id: openPlan(order).signer,
        receiver_id: call.receiverId,
        actions: [
          {
            FunctionCall: {
              method_name: call.method,
              args: Buffer.from(JSON.stringify(call.args)).toString("base64"),
              deposit: call.deposit,
              gas: call.gas,
            },
          },
        ],
      },
      transaction_outcome: { outcome },
      receipts_outcome: [{ id: "receipt", outcome }],
    });
    await db.update(tnOrders).set({ state: "submitted", txHash: "hash" }).where(eq(tnOrders.id, order.id));
    const submitted = await ownedOrder(db, owner.id, order.id);
    await reconcileStage(db, submitted);
    await reconcileStage(db, submitted);
    const balance = await ownedBalance(db, owner.id, USDC);
    expect(balance.units).toBe("1000000");
    expect(balance.held).toBe("0");
    expect((await ownedOrder(db, owner.id, order.id)).state).toBe("settled");
  });
  it("keeps an ended guest's holdings for its next session without sending a transaction", async () => {
    const { db, owner } = c;
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 2000000n, 1000000n));
    await db
      .update(tnOwners)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(tnOwners.id, owner.id));
    await expireTestnetGuest(db, owner.id);
    expect(await ownedBalance(db, owner.id, USDC)).toMatchObject({ units: "2000000", held: "1000000" });
    expect(testnetRpc).not.toHaveBeenCalled();
  });
  it("returns only an abandoned guest's free units to the pool", async () => {
    const { db, owner, stranger } = c;
    await poolTransaction(db, async (tx) => {
      await changeBalance(tx, owner.id, USDC, 2000000n, 1000000n);
      await changeBalance(tx, stranger.id, USDC, 2000000n, 0n);
    });
    await db
      .update(tnOwners)
      .set({ expiresAt: Date.now() - GUEST_RETENTION_MS - 1 })
      .where(eq(tnOwners.id, owner.id));
    await poolTransaction(db, (tx) => reclaimAbandonedGuests(tx, Date.now()));
    expect(await ownedBalance(db, owner.id, USDC)).toMatchObject({ units: "1000000", held: "1000000" });
    expect((await ownedBalance(db, stranger.id, USDC)).units).toBe("2000000");
  });
  it("rejects a stale balance observation after any other pool mutation", async () => {
    const { db, owner } = c;
    await poolTransaction(db, async () => undefined);
    await expect(
      poolTransaction(db, (tx) =>
        grantGuest(
          tx,
          owner,
          new Map([
            [USDC, 10000000n],
            ["native:near", 10n ** 25n],
          ]),
          0,
        ),
      ),
    ).rejects.toThrow("changed");
    expect(
      await db
        .select()
        .from(tnOrders)
        .where(and(eq(tnOrders.ownerId, owner.id), eq(tnOrders.state, "settled"))),
    ).toHaveLength(0);
  });
});
